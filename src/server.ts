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
  enforceRoutingCheck,
  enforceOfficialDocsRead,
  enforceContextMemoryEnabled,
  enforceObjectIdsValid,
} from './utils/wdpKnowledge';
import {
  logConversation,
  detectScene
} from './utils/logger';

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
      // 硬编码检查：必须有 user_requirement
      if (!args || typeof args.user_requirement !== 'string') {
        return {
          content: [{ 
            type: 'text', 
            text: '❌ 错误：缺少 user_requirement 参数\n\n请提供用户原始需求描述。' 
          }],
          isError: true
        };
      }

      // 硬编码检查：必须有 projectPath
      if (!args.projectPath || typeof args.projectPath !== 'string') {
        return {
          content: [{ 
            type: 'text', 
            text: '❌ 错误：缺少 projectPath 参数\n\n【必需】请在输入中指定工程路径，用于创建本地缓存。\n\n示例：\n调用start_wdp_workflow：了解WDP知识库机制\n\nprojectPath: D:/Projects/你的工程目录' 
          }],
          isError: true
        };
      }

      // ====== 硬编码执行工作流 ======
      const sessionId = getOrCreateSessionId(req.ip || 'unknown', (req as any).userInfo?.name);
      const userName = (req as any).userInfo?.name;
      const userRequirement = args.user_requirement;
      const projectPath = args.projectPath;
      
      console.error(`[Workflow] 开始执行工作流: ${userRequirement.substring(0, 50)}...`);
      
      // 1. 路由匹配（本地计算）
      const workflowResult = buildWorkflowResponse(userRequirement);
      const { scene, isScene5 } = detectScene(userRequirement);
      
      // 2. 硬编码读取必要技能（按顺序）
      const skillsToRead = [
        'wdp-entry-agent/SKILL.md',
        'wdp-intent-orchestrator/SKILL.md',
        ...workflowResult.matchedSkills
      ];
      
      const skillContents: any[] = [];
      const backendCalls: any[] = [];
      
      for (const skillPath of skillsToRead) {
        try {
          const content = readKnowledgeFile(KNOWLEDGE_BASE_PATH, skillPath);
          if (content) {
            skillContents.push({ path: skillPath, content: content.substring(0, 1000) + '...' });
            backendCalls.push({ type: 'skill', path: skillPath, status: 'success' });
            console.error(`[Workflow] 已读取: ${skillPath}`);
          }
        } catch (error) {
          backendCalls.push({ type: 'skill', path: skillPath, status: 'error', error: String(error) });
        }
      }
      
      // 3. 硬编码读取官方文档
      const officialContents: any[] = [];
      for (const officialPath of workflowResult.requiredOfficialFiles) {
        try {
          const content = readKnowledgeFile(KNOWLEDGE_BASE_PATH, officialPath);
          if (content) {
            officialContents.push({ path: officialPath, content: content.substring(0, 1000) + '...' });
            backendCalls.push({ type: 'official', path: officialPath, status: 'success' });
            console.error(`[Workflow] 已读取: ${officialPath}`);
          }
        } catch (error) {
          backendCalls.push({ type: 'official', path: officialPath, status: 'error', error: String(error) });
        }
      }
      
      // 4. 条件执行：长任务检查（skill > 1 或 official > 1）
      const isLongTask = workflowResult.matchedSkills.length > 1 || workflowResult.requiredOfficialFiles.length > 1;
      let contextMemoryCheck = null;
      if (isLongTask) {
        console.error('[Workflow] 长任务，执行 context_memory 检查');
        contextMemoryCheck = enforceContextMemoryEnabled(3, workflowResult.matchedSkills.length, true);
      }
      
      // 5. 条件执行：对象ID检查（涉及对象操作）
      const hasObjectOperation = /eid|entity|nodeid|featureid|对象|构件/i.test(userRequirement);
      let objectIdsCheck = null;
      if (hasObjectOperation) {
        console.error('[Workflow] 涉及对象操作，执行 object_ids 检查');
        objectIdsCheck = enforceObjectIdsValid([], true);
      }
      
      // 6. 构建完整响应
      const finalResult = {
        ...workflowResult,
        execution: {
          scene,
          isScene5,
          isLongTask,
          hasObjectOperation,
          skillsRead: skillContents.map(s => s.path),
          officialsRead: officialContents.map(o => o.path),
          checks: {
            contextMemory: contextMemoryCheck,
            objectIds: objectIdsCheck
          }
        },
        // 包含实际内容（限制长度避免过大）
        skillContents: skillContents.map(s => ({
          path: s.path,
          preview: s.content.substring(0, 500)
        })),
        officialContents: officialContents.map(o => ({
          path: o.path,
          preview: o.content.substring(0, 500)
        }))
      };
      
      // 7. 记录完整对话日志
      logConversation({
        sessionId,
        userName,
        userInput: userRequirement,
        toolName: 'start_wdp_workflow',
        toolArgs: args,
        scene,
        isScene5,
        projectPath,
        backendCalls,
        responsePreview: JSON.stringify(finalResult).substring(0, 500)
      });
      
      console.error(`[Workflow] 工作流执行完成，共读取 ${skillContents.length} 个skill，${officialContents.length} 个official文档`);
      
      return {
        content: [{ type: 'text', text: JSON.stringify(finalResult, null, 2) }]
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
      
      // 生成结构化摘要和文件哈希
      const { generateDigest, computeFileHash, digestToText } = await import('./utils/wdpKnowledge');
      const digest = generateDigest(content, args.path);
      const fileHash = computeFileHash(content);
      
      // 返回完整内容 + 摘要 + 哈希
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            content: content,           // 完整内容（首次使用）
            digest: digest,             // 结构化摘要
            digestText: digestToText(digest),  // 摘要文本格式
            fileHash: fileHash,         // 文件哈希（用于更新检测）
            path: args.path,
            timestamp: new Date().toISOString()
          }, null, 2)
        }]
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

    // ============ 约束检查工具 ============
    case 'enforce_routing_check': {
      if (!args || !args.workflow_result || !Array.isArray(args.skills_read)) {
        return {
          content: [{ type: 'text', text: '错误: 缺少必要参数 workflow_result 或 skills_read' }],
          isError: true
        };
      }

      const result = enforceRoutingCheck(args.workflow_result, args.skills_read);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.passed
      };
    }

    case 'enforce_official_docs_read': {
      if (!args || !Array.isArray(args.required_files) || !Array.isArray(args.files_read)) {
        return {
          content: [{ type: 'text', text: '错误: 缺少必要参数 required_files 或 files_read' }],
          isError: true
        };
      }

      const result = enforceOfficialDocsRead(args.required_files, args.files_read);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.passed
      };
    }

    case 'enforce_context_memory_check': {
      if (typeof args?.dialogue_rounds !== 'number' || typeof args?.skills_count !== 'number' || typeof args?.memory_enabled !== 'boolean') {
        return {
          content: [{ type: 'text', text: '错误: 缺少必要参数 dialogue_rounds, skills_count 或 memory_enabled' }],
          isError: true
        };
      }

      const result = enforceContextMemoryEnabled(args.dialogue_rounds, args.skills_count, args.memory_enabled);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.passed
      };
    }

    case 'enforce_object_ids_valid': {
      if (!args || !Array.isArray(args.object_ids)) {
        return {
          content: [{ type: 'text', text: '错误: 缺少必要参数 object_ids' }],
          isError: true
        };
      }

      const result = enforceObjectIdsValid(args.object_ids, args.allow_mock);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.passed
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
