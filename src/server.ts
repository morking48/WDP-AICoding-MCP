import express from 'express';
import cors from 'cors';
import { initTokenManager, verifyTokenAccess, verifyAdminToken, isTokenDisabled } from './utils/tokenManager';
import {
  initSkillKnowledge,
  handleMcpToolCall,
  getMcpToolDefinitions,
} from './utils/skillKnowledge';
import {
  initLogger,
  getOrCreateSessionId,
  logRequest,
  logSkillInvocation,
  logError,
  logAccess,
  logConversation,
  cleanupOldLogs,
} from './utils/logger';

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ========== 中间件 ==========
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ========== 认证中间件 ==========
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '缺少认证 Token，请在 Authorization 头中提供 Bearer <token>' });
    return;
  }
  const token = authHeader.slice(7);

  // 检查 Token 是否被禁用
  if (isTokenDisabled(token)) {
    logAccess({
      sessionId: getOrCreateSessionId(req.ip || 'unknown', 'anonymous'),
      ip: req.ip,
      action: 'AUTH_FAILED',
      reason: 'Token已禁用',
      userAgent: req.headers['user-agent'] as string,
    });
    res.status(403).json({ error: 'Token已被禁用', message: '您的访问权限已被禁用，请联系管理员' });
    return;
  }

  const result = verifyTokenAccess(token);
  if (!result.valid) {
    logAccess({
      sessionId: getOrCreateSessionId(req.ip || 'unknown', 'anonymous'),
      ip: req.ip,
      action: 'AUTH_FAILED',
      reason: result.reason,
      userAgent: req.headers['user-agent'] as string,
    });
    res.status(403).json({ error: result.reason || 'Token 无效' });
    return;
  }

  (req as any).userToken = token;
  (req as any).userName = result.userName || 'anonymous';
  next();
}

function adminAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = req.headers['x-admin-token'] as string;
  if (!adminToken || !verifyAdminToken(adminToken)) {
    res.status(403).json({ error: '无效的管理员Token' });
    return;
  }
  next();
}

// ========== 公开端点 ==========

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== MCP 端点（需认证）==========

// 获取工具列表
app.get('/mcp/tools', authMiddleware, (req, res) => {
  const userName = (req as any).userName || 'anonymous';
  const sessionId = getOrCreateSessionId(req.ip || 'unknown', userName);
  logAccess({
    sessionId,
    ip: req.ip,
    action: 'LIST_TOOLS',
    userName,
    userAgent: req.headers['user-agent'] as string,
  });
  res.json({ tools: getMcpToolDefinitions() });
});

// 工具调用
app.post('/mcp/call', authMiddleware, async (req, res) => {
  const startTime = Date.now();
  const { tool, arguments: args } = req.body;
  const userName = (req as any).userName || 'anonymous';
  const sessionId = getOrCreateSessionId(req.ip || 'unknown', userName);

  if (!tool) {
    logError({
      sessionId,
      errorCategory: 'INVALID_REQUEST',
      severity: 'low',
      errorMessage: '缺少 tool 参数',
      userName,
      context: {},
      recoverable: true,
      userImpact: '请求被拒绝',
    });
    res.status(400).json({ error: '缺少 tool 参数' });
    return;
  }

  try {
    const result = await handleMcpToolCall(tool, args || {});

    // 记录 Skill 调用日志
    if (tool === 'get_skill_content' || tool === 'start_wdp_workflow') {
      logSkillInvocation({
        sessionId,
        skillPath: args?.path || args?.user_requirement || '',
        toolName: tool,
        success: true,
        responseTimeMs: Date.now() - startTime,
        contentLength: JSON.stringify(result).length,
      });
    }

    // 记录请求日志（start_wdp_workflow 带意图分析）
    if (tool === 'start_wdp_workflow') {
      logRequest({
        sessionId,
        clientIp: req.ip || 'unknown',
        rawInput: args?.user_requirement || '',
        userName,
        detectedKeywords: result.matched_keywords || [],
        routedSkills: result.matched_skills || [],
        confidence: result.confidence || 1.0,
      });
    }

    // 记录对话日志
    const userInput = (args?.user_requirement || tool) as string;
    const isActMode = userInput.includes('开始编码') || userInput.includes('编码');
    logConversation({
      sessionId,
      userName,
      userInput,
      toolName: tool,
      toolArgs: args || {},
      scene: isActMode ? 'Act模式-开始编码' : 'Plan模式-分析查询',
      isScene5: false,
      projectPath: args?.projectPath,
      responsePreview: JSON.stringify(result).substring(0, 500),
    });

    logAccess({
      sessionId,
      ip: req.ip,
      action: 'MCP_TOOL_CALL',
      userName,
      tool,
      responseTimeMs: Date.now() - startTime,
      userAgent: req.headers['user-agent'] as string,
    });

    res.json(result);
  } catch (error: any) {
    logError({
      sessionId,
      errorCategory: 'TOOL_CALL_ERROR',
      severity: 'high',
      errorMessage: error.message || '工具调用失败',
      userName,
      context: { userInput: tool },
      recoverable: true,
      userImpact: '工具调用失败',
    });

    logAccess({
      sessionId,
      ip: req.ip,
      action: 'MCP_TOOL_CALL_ERROR',
      userName,
      tool,
      error: error.message,
      responseTimeMs: Date.now() - startTime,
      userAgent: req.headers['user-agent'] as string,
    });

    res.status(500).json({ error: error.message || '工具调用失败' });
  }
});

// ========== Admin 端点（需管理员认证）==========

// Token 管理
app.get('/admin/tokens', adminAuthMiddleware, (_req, res) => {
  const { listTokens, getTokenStats } = require('./utils/tokenManager');
  res.json({ tokens: listTokens(), stats: getTokenStats() });
});

app.post('/admin/tokens', adminAuthMiddleware, (req, res) => {
  const { token, name } = req.body;
  if (!token || !name) {
    res.status(400).json({ error: '缺少 token 或 name 参数' });
    return;
  }
  const { addToken } = require('./utils/tokenManager');
  const ok = addToken(token, name);
  res.json({ success: ok, message: ok ? 'Token 已添加' : 'Token 已存在' });
});

app.delete('/admin/tokens/:token', adminAuthMiddleware, (req, res) => {
  const { deleteToken } = require('./utils/tokenManager');
  const ok = deleteToken(req.params.token);
  res.json({ success: ok, message: ok ? 'Token 已删除' : 'Token 不存在' });
});

app.post('/admin/tokens/:token/disable', adminAuthMiddleware, (req, res) => {
  const { disableToken } = require('./utils/tokenManager');
  const ok = disableToken(req.params.token, req.body.reason);
  res.json({ success: ok, message: ok ? 'Token 已禁用' : 'Token 不存在' });
});

app.post('/admin/tokens/:token/enable', adminAuthMiddleware, (req, res) => {
  const { enableToken } = require('./utils/tokenManager');
  const ok = enableToken(req.params.token);
  res.json({ success: ok, message: ok ? 'Token 已启用' : 'Token 不存在' });
});

// ========== 启动 ==========
async function start() {
  // 初始化 Token 管理器
  initTokenManager();

  // 初始化日志系统（文件 + SQLite 双写）
  await initLogger();

  // 清理旧日志（保留 30 天）
  cleanupOldLogs(30);

  // 初始化 Skill 知识库（从远程拉取 manifest）
  let skillInitOk = false;
  try {
    await initSkillKnowledge();
    skillInitOk = true;
  } catch (error: any) {
    console.warn('[Server] Skill 知识库初始化失败（服务仍可启动）:', error.message);
  }

  const SKILL_SERVER_URL = process.env.SKILL_SERVER_URL || 'http://wdpapi-skill.51aes.com';

  app.listen(Number(PORT), HOST, () => {
    console.log(`\n🚀 WDP MCP API Server 已启动`);
    console.log(`📡 HTTP API: http://${HOST}:${PORT}`);
    console.log(`🌐 本地访问: http://localhost:${PORT}`);
    console.log(`📚 Skill Server: ${SKILL_SERVER_URL} ${skillInitOk ? '✅' : '⚠️ 连接失败'}`);
    console.log(`📝 日志目录: logs/`);
    console.log(`\n可用端点:`);
    console.log(`  GET  /health              - 健康检查`);
    console.log(`  GET  /mcp/tools           - MCP 工具列表`);
    console.log(`  POST /mcp/call            - MCP 工具调用`);
    console.log(`\n📊 Admin 管理接口 (x-admin-token):`);
    console.log(`  GET  /admin/tokens        - Token 列表`);
    console.log(`  POST /admin/tokens        - 添加 Token`);
    console.log(`  DELETE /admin/tokens/:token - 删除 Token`);
    console.log(`  POST /admin/tokens/:token/disable - 禁用 Token`);
    console.log(`  POST /admin/tokens/:token/enable  - 启用 Token`);

    const { getValidTokens } = require('./utils/tokenManager');
    const allTokens = getValidTokens();
    if (allTokens.length === 0) {
      console.log(`\n⚠️  警告: 当前没有配置任何有效 Token`);
      console.log(`   请设置 VALID_TOKENS 环境变量或通过 Admin API 添加`);
    } else {
      console.log(`\n🔑 认证方式: Bearer Token`);
      console.log(`   有效 Token: ${allTokens.length} 个`);
    }
  });
}

start().catch(console.error);