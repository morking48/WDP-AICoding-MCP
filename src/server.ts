/**
 * WDP 云端知识引擎 - HTTP Server
 * 提供双协议支持：HTTP REST API + MCP (通过 SSE/WebSocket 桥接)
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { 
  getOrCreateSessionId, 
  logRequest, 
  logSkillInvocation, 
  logError, 
  logSessionEnd,
  cleanupOldLogs,
  initLogger
} from './utils/logger';
import {
  initTokenManager,
  addToken,
  updateToken,
  deleteToken,
  disableToken,
  enableToken,
  verifyToken,
  listTokens,
  verifyAdminToken,
  getValidTokens,
  getTokenStats,
  checkPathPermission as checkTokenPathPermission,
  isTokenDisabled,
  getTokenPermissionDescription,
  isSensitivePath
} from './utils/tokenManager';
import {
  MCP_TOOL_DEFINITIONS,
  buildKnowledgeQueryResponse,
  buildWorkflowResponse,
  listKnowledgeEntries,
  readKnowledgeFile,
} from './utils/wdpKnowledge';

// 配置
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';  // 默认监听所有网络接口，支持远程访问

// 从环境变量加载Token配置
// 格式：VALID_TOKENS=token1:名称1,token2:名称2
// 如果没有设置，默认为空（需要管理员手动添加）
const rawTokens = process.env.VALID_TOKENS || '';
const VALID_TOKENS: string[] = [];

if (rawTokens) {
  rawTokens.split(',').forEach(tokenConfig => {
    const [token, name] = tokenConfig.split(':');
    if (token) {
      VALID_TOKENS.push(token);
    }
  });
}

const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH 
  ? path.resolve(process.env.KNOWLEDGE_BASE_PATH)
  : path.resolve(__dirname, '../../WDP_AIcoding/skills');
const LOGS_PATH = path.resolve(__dirname, '../logs/access.log');

// Express 应用
const app = express();
const server = createServer(app);

// 中间件
app.use(cors());
app.use(express.json());

/**
 * 鉴权中间件
 */
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
  
  if (!token) {
    return res.status(401).json({ error: '缺少认证 Token' });
  }
  
  // 检查Token是否被禁用
  if (isTokenDisabled(token)) {
    logAccess(req, 'AUTH_FAILED', { token, reason: 'Token已禁用' });
    return res.status(403).json({ 
      error: 'Token已被禁用',
      message: '您的访问权限已被禁用，请联系管理员'
    });
  }
  
  const tokenInfo = verifyToken(token);
  if (!tokenInfo) {
    logAccess(req, 'AUTH_FAILED', { token });
    return res.status(403).json({ error: '无效的 Token' });
  }
  
  // 将 token 关联的用户信息附加到请求
  (req as any).userToken = token;
  (req as any).userInfo = tokenInfo;
  next();
};

/**
 * 日志记录 - 使用高级日志系统（增强版）
 */
const logAccess = (req: Request, action: string, data: any = {}) => {
  // 获取用户信息
  const userInfo = (req as any).userInfo;
  const userName = userInfo?.name || 'anonymous';
  
  // 获取或创建会话ID（传入正确的用户名）
  const sessionId = getOrCreateSessionId(req.ip || 'unknown', userName);
  
  // 记录开始时间（用于计算响应时间）
  const startTime = Date.now();
  
  // 根据action类型调用不同的日志函数
  switch (action) {
    case 'GET_KNOWLEDGE':
    case 'QUERY_KNOWLEDGE':
      logRequest({
        sessionId,
        clientIp: req.ip || 'unknown',
        rawInput: data.query || data.path || '',
        detectedKeywords: data.keywords || [],
        routedSkills: data.skills || [],
        confidence: data.confidence || 1.0
      });
      break;
      
    case 'MCP_TOOL_CALL':
      if (data.tool === 'get_skill_content') {
        logSkillInvocation({
          sessionId,
          skillPath: data.args?.path || '',
          toolName: data.tool,
          success: true,
          responseTimeMs: Date.now() - startTime,
          contentLength: data.result?.length || 0
        });
      }
      break;
      
    case 'ACCESS_DENIED':
      logError({
        sessionId,
        errorCategory: 'ACCESS_DENIED',
        severity: 'medium',
        errorMessage: data.reason || 'Access denied',
        context: {
          userInput: data.path,
          routedSkill: data.path,
          userName
        },
        recoverable: true,
        userImpact: 'User cannot access restricted content'
      });
      break;
      
    case 'AUTH_FAILED':
      logError({
        sessionId,
        errorCategory: 'AUTH_FAILED',
        severity: 'high',
        errorMessage: data.reason || 'Authentication failed',
        context: { userName },
        recoverable: false,
        userImpact: 'User cannot access system'
      });
      break;
  }
  
  // 增强版访问日志
  const logEntry = {
    timestamp: new Date().toISOString(),
    type: 'access',
    ip: req.ip,
    action,
    userAgent: req.headers['user-agent'],
    sessionId,
    userName,
    responseTimeMs: Date.now() - startTime,
    ...data
  };
  
  // 使用导入的 logAccess 函数（内部已实现双写）
  const { logAccess: logAccessFunc } = require('./utils/logger');
  logAccessFunc(logEntry);
  
  // 同时保留控制台输出
  console.log(`[LOG] ${action}:`, JSON.stringify(logEntry, null, 2));
};

// ============ HTTP API 路由 ============

/**
 * 健康检查
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * 获取知识内容
 * GET /api/knowledge?path=xxx
 * 新策略：所有用户都可以访问，但公开用户不能查询SKILL.md详细内容
 */
app.get('/api/knowledge', authMiddleware, (req: Request, res: Response) => {
  const { path: skillPath } = req.query;
  const token = (req as any).userToken;
  const userInfo = (req as any).userInfo;
  
  if (!skillPath || typeof skillPath !== 'string') {
    return res.status(400).json({ error: '缺少 path 参数' });
  }
  
  // 检查Token是否被禁用
  if (isTokenDisabled(token)) {
    logAccess(req, 'ACCESS_DENIED', { path: skillPath, reason: 'Token已禁用' });
    return res.status(403).json({ 
      error: 'Token已被禁用',
      message: '您的访问权限已被禁用，请联系管理员'
    });
  }
  
  // 检查是否为敏感路径
  if (isSensitivePath(skillPath)) {
    logAccess(req, 'ACCESS_DENIED', { path: skillPath, reason: '敏感资源' });
    return res.status(403).json({ 
      error: '无权访问该资源',
      message: '该资源受到保护，无法访问'
    });
  }
  
  logAccess(req, 'GET_KNOWLEDGE', { path: skillPath, user: userInfo?.name });
  
  const content = readKnowledgeFile(KNOWLEDGE_BASE_PATH, skillPath);
  
  if (!content) {
    return res.status(404).json({ error: '知识文件未找到' });
  }
  
  res.json({
    success: true,
    path: skillPath,
    content,
    timestamp: new Date().toISOString()
  });
});

/**
 * 查询知识 (POST，支持复杂查询)
 * POST /api/query
 */
app.post('/api/query', authMiddleware, (req: Request, res: Response) => {
  const { query, skill_path } = req.body;
  const token = (req as any).userToken;
  
  if (!query) {
    return res.status(400).json({ error: '缺少 query 参数' });
  }
  
  if (skill_path && typeof skill_path === 'string' && isSensitivePath(skill_path)) {
    logAccess(req, 'ACCESS_DENIED', { path: skill_path, reason: '敏感资源' });
    return res.status(403).json({
      error: '无权访问该资源',
      message: '该资源受到保护，无法访问'
    });
  }

  const response = buildKnowledgeQueryResponse(
    KNOWLEDGE_BASE_PATH,
    query,
    typeof skill_path === 'string' ? skill_path : undefined,
  );

  logAccess(req, 'QUERY_KNOWLEDGE', {
    query,
    skill_path,
    keywords: response.expandedQueries,
    skills: response.matchedSkills,
    confidence: response.confidence,
    mode: response.mode,
  });

  res.json(response);
});

/**
 * 列出所有可用技能
 * GET /api/skills
 */
app.get('/api/skills', authMiddleware, (req: Request, res: Response) => {
  const includeReferences =
    req.query.include_references === 'true' || req.query.includeReferences === 'true';
  
  logAccess(req, 'LIST_SKILLS', {});
  
  const skills = listKnowledgeEntries(KNOWLEDGE_BASE_PATH, {
    includeReferences,
  });
  
  res.json({
    success: true,
    skills,
    includeReferences,
    timestamp: new Date().toISOString()
  });
});

// ============ MCP 代理端点 ============

/**
 * MCP 工具调用处理
 */
async function handleMcpToolCall(name: string, args: any, req: Request): Promise<any> {
  switch (name) {
    case 'start_wdp_workflow': {
      if (!args || typeof args.user_requirement !== 'string') {
        throw new Error('缺少 user_requirement 参数');
      }

      const result = buildWorkflowResponse(args.user_requirement);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }

    case 'query_knowledge': {
      if (!args || typeof args.query !== 'string') {
        throw new Error('缺少 query 参数');
      }
      if (args.skill_path && typeof args.skill_path === 'string' && isSensitivePath(args.skill_path)) {
        return {
          content: [{ type: 'text', text: '错误: 无权访问该资源' }],
          isError: true
        };
      }

      const results = buildKnowledgeQueryResponse(
        KNOWLEDGE_BASE_PATH,
        args.query,
        typeof args.skill_path === 'string' ? args.skill_path : undefined,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
      };
    }

    case 'get_skill_content': {
      if (!args || typeof args.path !== 'string') {
        throw new Error('缺少 path 参数');
      }
      
      // 检查是否为敏感路径
      if (isSensitivePath(args.path)) {
        return {
          content: [{ type: 'text', text: '错误: 无权访问该资源' }],
          isError: true
        };
      }
      
      const content = readKnowledgeFile(KNOWLEDGE_BASE_PATH, args.path);
      
      if (!content) {
        return {
          content: [{ type: 'text', text: `错误: 知识文件未找到: ${args.path}` }],
          isError: true
        };
      }
      
      return {
        content: [{ type: 'text', text: content }]
      };
    }

    case 'list_skills': {
      const skills = listKnowledgeEntries(KNOWLEDGE_BASE_PATH, {
        includeReferences: Boolean(args?.include_references),
      });
      
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          skills,
          includeReferences: Boolean(args?.include_references),
          timestamp: new Date().toISOString()
        }, null, 2) }]
      };
    }

    case 'check_health': {
      const exists = fs.existsSync(KNOWLEDGE_BASE_PATH);
      
      return {
        content: [{ type: 'text', text: `服务状态: ${exists ? '正常' : '知识库路径不存在'}\n知识库路径: ${KNOWLEDGE_BASE_PATH}\n时间: ${new Date().toISOString()}` }]
      };
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

// MCP 代理端点：获取工具定义
app.get('/mcp/tools', authMiddleware, (req: Request, res: Response) => {
  logAccess(req, 'MCP_TOOLS_LIST', {});
  res.json({ tools: MCP_TOOL_DEFINITIONS });
});

// MCP 代理端点：调用工具
app.post('/mcp/call', authMiddleware, async (req: Request, res: Response) => {
  const { name, arguments: args } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: '缺少 name 参数' });
  }
  
  logAccess(req, 'MCP_TOOL_CALL', { tool: name, args });
  
  try {
    const result = await handleMcpToolCall(name, args, req);
    res.json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('MCP 工具调用失败:', error);
    res.status(500).json({ 
      content: [{ type: 'text', text: `错误: ${errorMessage}` }],
      isError: true 
    });
  }
});

// ============ Token管理API（需要管理员权限） ============

/**
 * 管理员验证中间件
 */
const adminMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const adminToken = req.headers['x-admin-token'] as string;
  
  if (!adminToken || !verifyAdminToken(adminToken)) {
    return res.status(403).json({ error: '无效的管理员Token' });
  }
  
  next();
};

/**
 * 获取所有Token列表
 * GET /admin/tokens
 */
app.get('/admin/tokens', adminMiddleware, (req: Request, res: Response) => {
  const tokens = listTokens().map(({ token, info }) => ({
    token: token.substring(0, 8) + '...', // 隐藏完整Token
    name: info.name,
    disabled: info.disabled,
    disabledReason: info.disabledReason,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt
  }));
  
  res.json({
    success: true,
    tokens,
    stats: getTokenStats()
  });
});

/**
 * 添加新Token
 * POST /admin/tokens
 */
app.post('/admin/tokens', adminMiddleware, (req: Request, res: Response) => {
  const { token, name } = req.body;
  
  if (!token || !name) {
    return res.status(400).json({ error: '缺少必要参数：token, name' });
  }

  const success = addToken(token, name);
  
  if (!success) {
    return res.status(409).json({ error: 'Token已存在' });
  }
  
  logAccess(req, 'ADMIN_ADD_TOKEN', { name });
  
  res.json({
    success: true,
    message: `Token添加成功: ${name}`,
    token: token.substring(0, 8) + '...'
  });
});

/**
 * 更新Token权限
 * PUT /admin/tokens/:token
 */
app.put('/admin/tokens/:token', adminMiddleware, (req: Request, res: Response) => {
  const { token } = req.params;
  const { name } = req.body;
  
  const success = updateToken(token, { name });
  
  if (!success) {
    return res.status(404).json({ error: 'Token不存在' });
  }
  
  logAccess(req, 'ADMIN_UPDATE_TOKEN', { token: token.substring(0, 8) + '...', name });
  
  res.json({
    success: true,
    message: 'Token更新成功'
  });
});

/**
 * 删除Token
 * DELETE /admin/tokens/:token
 */
app.delete('/admin/tokens/:token', adminMiddleware, (req: Request, res: Response) => {
  const { token } = req.params;
  
  const success = deleteToken(token);
  
  if (!success) {
    return res.status(404).json({ error: 'Token不存在' });
  }
  
  logAccess(req, 'ADMIN_DELETE_TOKEN', { token: token.substring(0, 8) + '...' });
  
  res.json({
    success: true,
    message: 'Token删除成功'
  });
});

/**
 * 禁用Token
 * POST /admin/tokens/:token/disable
 */
app.post('/admin/tokens/:token/disable', adminMiddleware, (req: Request, res: Response) => {
  const { token } = req.params;
  const { reason } = req.body;
  
  const success = disableToken(token, reason);
  
  if (!success) {
    return res.status(404).json({ error: 'Token不存在' });
  }
  
  logAccess(req, 'ADMIN_DISABLE_TOKEN', { token: token.substring(0, 8) + '...', reason });
  
  res.json({
    success: true,
    message: 'Token已禁用',
    reason: reason || '管理员禁用'
  });
});

/**
 * 启用Token
 * POST /admin/tokens/:token/enable
 */
app.post('/admin/tokens/:token/enable', adminMiddleware, (req: Request, res: Response) => {
  const { token } = req.params;
  
  const success = enableToken(token);
  
  if (!success) {
    return res.status(404).json({ error: 'Token不存在' });
  }
  
  logAccess(req, 'ADMIN_ENABLE_TOKEN', { token: token.substring(0, 8) + '...' });
  
  res.json({
    success: true,
    message: 'Token已启用'
  });
});

// 错误处理
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 初始化Token管理器
initTokenManager();

// 初始化日志系统（包括数据库）
initLogger().then(() => {
  console.log('[Server] 日志系统初始化完成');
}).catch(err => {
  console.error('[Server] 日志系统初始化失败:', err);
});

// 启动服务器
server.listen(Number(PORT), HOST, () => {
  console.log(`\n🚀 WDP 云端知识引擎已启动`);
  console.log(`📡 HTTP API: http://${HOST}:${PORT}`);
  console.log(`🌐 本地访问: http://localhost:${PORT}`);
  console.log(`🔌 远程访问: http://<你的IP地址>:${PORT}`);
  console.log(`📚 知识库路径: ${KNOWLEDGE_BASE_PATH}`);
  console.log(`📝 日志路径: ${LOGS_PATH}`);
  console.log(`\n可用端点:`);
  console.log(`  GET  /health              - 健康检查`);
  console.log(`  GET  /api/knowledge       - 获取知识内容`);
  console.log(`  POST /api/query          - 查询知识`);
  console.log(`  GET  /api/skills         - 列出所有技能`);
  
  // 检查是否有有效Token（环境变量 + 持久化文件）
  const allTokens = getValidTokens();
  if (allTokens.length === 0) {
    console.log(`\n⚠️  警告: 当前没有配置任何有效Token`);
    console.log(`   请使用以下命令添加Token:`);
    console.log(`   npm run token -- add <token> <名称>`);
    console.log(`   或设置 VALID_TOKENS 环境变量`);
  } else {
    console.log(`\n认证方式: Bearer Token`);
    console.log(`有效 Token: ${allTokens.length} 个`);
  }
});
