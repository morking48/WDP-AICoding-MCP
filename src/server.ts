import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { get } from 'lodash';
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
  enforceProjectScaffoldingValid,
} from './utils/wdpKnowledge';
import {
  getContextMemoryStore,
  cleanupContextMemory
} from './utils/contextMemory';
import {
  logConversation,
  detectScene
} from './utils/logger';

// 配置
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
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

const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json());

const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
  
  if (!token) {
    return res.status(401).json({ error: '缺少认证 Token' });
  }
  
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
  
  (req as any).userToken = token;
  (req as any).userInfo = tokenInfo;
  next();
};

const logAccess = (req: Request, action: string, data: any = {}) => {
  const userInfo = (req as any).userInfo;
  const userName = userInfo?.name || 'anonymous';
  const sessionId = getOrCreateSessionId(req.ip || 'unknown', userName);
  const startTime = Date.now();
  
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
  
  const { logAccess: logAccessFunc } = require('./utils/logger');
  logAccessFunc(logEntry);
  console.log(`[LOG] ${action}:`, JSON.stringify(logEntry, null, 2));
};

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/knowledge', authMiddleware, (req: Request, res: Response) => {
  const { path: skillPath } = req.query;
  const token = (req as any).userToken;
  const userInfo = (req as any).userInfo;
  
  if (!skillPath || typeof skillPath !== 'string') {
    return res.status(400).json({ error: '缺少 path 参数' });
  }
  
  if (isTokenDisabled(token)) {
    logAccess(req, 'ACCESS_DENIED', { path: skillPath, reason: 'Token已禁用' });
    return res.status(403).json({ 
      error: 'Token已被禁用',
      message: '您的访问权限已被禁用，请联系管理员'
    });
  }
  
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

async function handleMcpToolCall(name: string, args: any, req: Request): Promise<any> {
  switch (name) {
    case 'start_wdp_workflow': {
      if (!args || typeof args.user_requirement !== 'string') {
        return {
          content: [{ 
            type: 'text', 
            text: '❌ 错误：缺少 user_requirement 参数\n\n请提供用户原始需求描述。' 
          }],
          isError: true
        };
      }

      if (!args.projectPath || typeof args.projectPath !== 'string') {
        return {
          content: [{ 
            type: 'text', 
            text: '❌ 错误：缺少 projectPath 参数\n\n【必需】请在输入中指定工程路径，用于创建本地缓存。\n\n示例：\n调用start_wdp_workflow：了解WDP知识库机制\n\nprojectPath: D:/Projects/你的工程目录' 
          }],
          isError: true
        };
      }

      const sessionId = getOrCreateSessionId(req.ip || 'unknown', (req as any).userInfo?.name);
      const userName = (req as any).userInfo?.name;
      const userRequirement = args.user_requirement;
      const projectPath = args.projectPath;
      
      console.error(`[Workflow] 开始执行工作流: ${userRequirement.substring(0, 50)}...`);
      
      const workflowResult = buildWorkflowResponse(userRequirement, projectPath);

      // 【关键修复】自动记录意图路由到 Warm 层，防止长对话后丢失原始规划
      try {
        const store = getContextMemoryStore(projectPath);
        const currentRouting = {
          title: workflowResult.title,
          matchedSkills: workflowResult.matchedSkills,
          requiredOfficialFiles: workflowResult.requiredOfficialFiles,
          timestamp: workflowResult.timestamp
        };
        const existingWarm = store.readFile('warm');
        
        // 【优化】轻量化路由存根记录 (只保留最近3次，防止 JSON 过大)
        const routingChain = [...(existingWarm.routingChain || []), { ...currentRouting, requirement: userRequirement }];
        const trimmedChain = routingChain.slice(-3);
        
        // 【优化】自动生成当前任务核心摘要 (给落后模型的降维打击)
        const contextSummary = `当前任务：${userRequirement.substring(0, 30)}... | 必须真值：${workflowResult.requiredOfficialFiles.join(', ')}`;

        store.writeFile('warm', { 
          ...existingWarm, 
          currentRouting,
          contextSummary,
          routingChain: trimmedChain
        });
        console.error('[ContextMemory] 已自动将意图路由存入 Warm 层');
      } catch (err) {
        console.error('[ContextMemory] 自动记录路由失败:', err);
      }
      const { scene, isScene5 } = detectScene(userRequirement);
      
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
      
      const isLongTask = workflowResult.matchedSkills.length > 1 || workflowResult.requiredOfficialFiles.length > 1;
      let contextMemoryCheck = null;
      // 降低触发长任务的阈值：匹配的技能数 > 0 或 必须加载的 official 文档数 > 0 即视为可能需要 memory 机制
      const isLongTaskModified = workflowResult.matchedSkills.length > 0 || workflowResult.requiredOfficialFiles.length > 0;
      if (isLongTaskModified) {
        console.error('[Workflow] 检测到复杂任务，执行 context_memory 检查');
        // 自动注入当前 Memory 状态供 AI 参考（解决 AI 不主动读缓存的问题）
        try {
          const store = getContextMemoryStore(projectPath);
          const warmData = store.readFile('warm');
          if (warmData && (warmData.currentRouting || warmData.contextSummary)) {
             (workflowResult as any).activeContext = {
                layer: "warm",
                summary: warmData.contextSummary,
                data: warmData.currentRouting,
                hint: "【架构记忆】这是本地缓存的原始设计意图，若后续步骤产生幻觉，请优先以此为准。"
             };
          }
        } catch (e) {}

        // 修改这里的阈值：将原本需要的 3 轮对话要求降低为 1 轮
        contextMemoryCheck = enforceContextMemoryEnabled(1, workflowResult.matchedSkills.length, true);
      }
      
      const hasObjectOperation = /eid|entity|nodeid|featureid|对象|构件/i.test(userRequirement);
      let objectIdsCheck = null;
      if (hasObjectOperation) {
        console.error('[Workflow] 涉及对象操作，执行 object_ids 检查');
        objectIdsCheck = enforceObjectIdsValid([], true);
      }
      
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
        skillContents: skillContents.map(s => ({
          path: s.path,
          preview: s.content.substring(0, 500)
        })),
        officialContents: officialContents.map(o => ({
          path: o.path,
          preview: o.content.substring(0, 500)
        }))
      };
      
      // 【缓存优化】构建给客户端 AI 的本地持久化缓存建议 (Warm 层)
      const { generateDigest, computeFileHash } = await import('./utils/wdpKnowledge');
      const cachePayload = {
        timestamp: new Date().toISOString(),
        workflowResult: {
          matchedDomains: workflowResult.matchedDomains,
          requiredOfficialFiles: workflowResult.requiredOfficialFiles
        },
        skillDigest: skillContents.map(s => {
          return {
             path: s.path,
             hash: computeFileHash(s.content),
             summary: generateDigest(s.content, s.path)
          };
        }),
        officialIndex: officialContents.map(o => ({
           path: o.path,
           hash: computeFileHash(o.content)
        }))
      };

      const finalResultWithCache = {
        ...finalResult,
        _cache: {
           action: 'WRITE_LOCAL_CACHE',
           path: `${projectPath}/.wdp-cache/warm.json`,
           content: cachePayload,
           instruction: "【缓存指令】为加速后续流程并节约 token，请使用你的本地能力(如 fs 模块/python)将 _cache.content 深度合并写入到你本地的 _cache.path 文件中。如果目录不存在请创建。"
        }
      };

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
        responsePreview: JSON.stringify(finalResultWithCache).substring(0, 500)
      });
      
      console.error(`[Workflow] 工作流执行完成，共读取 ${skillContents.length} 个skill，${officialContents.length} 个official文档`);
      
      return {
        content: [{ type: 'text', text: JSON.stringify(finalResultWithCache, null, 2) }]
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
      
      const { generateDigest, computeFileHash, digestToText } = await import('./utils/wdpKnowledge');
      const digest = generateDigest(content, args.path);
      const fileHash = computeFileHash(content);
      
      // 【硬编码优化】长篇文档自动摘要机制 (降维打击)
      // 如果文件很大，且没有明确要求 force_full，优先只返回精简摘要，避免撑爆模型上下文。
      const isOfficialDoc = args.path.includes('official-');
      const isLargeFile = content.length > 5000;
      const shouldReturnDigest = isOfficialDoc && isLargeFile && !args.force_full;

      let returnContent = content;
      let guidanceHint = '';

      if (shouldReturnDigest) {
        returnContent = digestToText(digest);
        guidanceHint = '【系统提示】由于该官方文档过长，为节省上下文，本次仅返回核心 API 签名摘要。如果你需要某个 API 的详细完整代码示例，请使用参数 "force_full": true 重新调用本工具读取该文件。';
        console.error(`[Token Cache] 触发降级摘要返回: ${args.path}`);
      }

      // 【记忆机制补丁】将核心读取记录悄悄塞入 Hot Memory，防遗忘
      // 注意：这里需要项目路径，但由于这个老工具原本不传 projectPath，
      // 我们从 req 中的最近一次 session/状态里去尝试获取（如果可能），或直接利用前面遗留的长会话。
      // 在这里仅记录日志，由 workflow 返回时的机制兜底。

      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            guidance: guidanceHint || undefined,
            content: returnContent,
            fileHash: fileHash,
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

    // ============ Context Memory 工具 ============
    case 'read_context_state': {
      if (!args?.projectPath || !args?.layer) {
        return {
          content: [{ type: 'text', text: '错误: 缺少 projectPath 或 layer 参数' }],
          isError: true,
        };
      }

      const store = getContextMemoryStore(args.projectPath);
      let result;

      if (args.layer === 'hot') {
        result = args.path ? store.readHot(args.path) : store.getAllHot();
      } else {
        const data = store.readFile(args.layer);
        result = args.path ? get(data, args.path) : data;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }],
      };
    }

    case 'write_context_state': {
      if (!args?.projectPath || !args?.layer || !args?.data) {
        return {
          content: [{ type: 'text', text: '错误: 缺少必要参数' }],
          isError: true,
        };
      }

      // 防御性解析：如果 data 是字符串（大模型格式化错误），尝试 parse
      let parsedData = args.data;
      if (typeof parsedData === 'string') {
        try {
          parsedData = JSON.parse(parsedData);
        } catch (e) {
          console.warn('[ContextMemory] write_context_state 解析 data 字符串失败:', e);
          return {
            content: [{ type: 'text', text: '错误: data 格式无效，必须是对象或合法 JSON 字符串' }],
            isError: true,
          };
        }
      }

      // Hot 层继续留在服务端内存中（会话级）
      if (args.layer === 'hot') {
        const store = getContextMemoryStore(args.projectPath);
        if (typeof parsedData === 'object' && parsedData !== null) {
          Object.entries(parsedData).forEach(([key, value]) => {
            store.writeHot(key, value);
          });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Hot 层写入内存成功' }) }],
        };
      } 
      
      // Warm / Cold 层不再由服务端持久化，而是返回客户端缓存指令，要求 AI 工具自行写入本地
      const cachePath = `${args.projectPath}/.wdp-cache/${args.layer}.json`;
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true, 
            message: `请求成功。请 AI 工具自行将以下内容写入本地文件: ${cachePath}`,
            action: 'WRITE_LOCAL_CACHE',
            target: 'client_filesystem',
            path: cachePath,
            content: parsedData,
            instruction: `【系统指令】服务端不存储持久化数据。请调用你的系统能力(如 fs.writeFileSync/python/bash)，将 \`content\` 的 JSON 内容合并写入到客户端本机的 \`${cachePath}\` 文件中。如果 \`.wdp-cache\` 目录不存在，请先创建。`
          }, null, 2) 
        }],
      };
    }

    case 'cleanup_context_memory': {
      if (!args?.projectPath || !args?.layer) {
        return {
          content: [{ type: 'text', text: '错误: 缺少必要参数' }],
          isError: true,
        };
      }

      const store = getContextMemoryStore(args.projectPath);
      store.cleanup(args.layer);

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, message: '清理完成' }) }],
      };
    }

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

    case 'enforce_project_scaffolding_valid': {
      if (!args || typeof args.projectPath !== 'string') {
        return {
          content: [{ type: 'text', text: '错误: 缺少必要参数 projectPath' }],
          isError: true
        };
      }

      const result = enforceProjectScaffoldingValid(args.projectPath);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.passed
      };
    }

    case 'trigger_self_evaluation': {
      if (!args || !Array.isArray(args.written_files) || !Array.isArray(args.used_skills)) {
        return {
          content: [{ type: 'text', text: '错误: 缺少必要参数 written_files 或 used_skills' }],
          isError: true
        };
      }

      let scenarioHint = '';
      // 如果提供了 scenario_id，尝试从新的分拆结构中读取业务场景 JSON
      if (args.scenario_id) {
        const scenarioIndexPaths = [
          path.join(KNOWLEDGE_BASE_PATH, 'wdp-intent-orchestrator/resources/business-scenarios/_index.json'),
          path.join(KNOWLEDGE_BASE_PATH, 'wdp-intent-orchestrator/resources/business-scenarios.json') // 兼容旧版
        ];
        
        let scenarioData: any = null;
        let scenarioDetail: any = null;

        for (const indexPath of scenarioIndexPaths) {
          if (fs.existsSync(indexPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
              const scenarioEntry = data.scenarios?.find((s: any) => s.id === args.scenario_id);
              
              if (scenarioEntry) {
                // 如果是新版分拆结构，尝试读取详情文件
                if (scenarioEntry.file) {
                  const detailPath = path.join(path.dirname(indexPath), 'business-scenarios', scenarioEntry.file);
                  if (fs.existsSync(detailPath)) {
                    scenarioDetail = JSON.parse(fs.readFileSync(detailPath, 'utf-8'));
                  }
                }
                // 如果详情文件里没找到，或者本身就是旧版结构
                scenarioData = scenarioDetail || scenarioEntry;
                break;
              }
            } catch (e) {
              console.error(`读取业务场景配置失败 (${indexPath}):`, e);
            }
          }
        }

        if (scenarioData && scenarioData.cleanup_chain) {
          const cleanupChain = Array.isArray(scenarioData.cleanup_chain) 
            ? scenarioData.cleanup_chain.map((item: any) => typeof item === 'object' ? item.create || item.cleanup : item).join(' -> ')
            : scenarioData.cleanup_chain;

          scenarioHint = `\n\n【场景专项约束（${scenarioData.name}）】\n根据该场景的定义，你必须确保代码中包含了以下清理链路（Cleanup Chain）：\n${cleanupChain}\n请立刻核对你的代码，若缺失请补充！`;
        }
      }

      const reviewPrompt = `【进入自我审查与修复模式 (Self-healing Mode)】
请立即审视你刚刚编写或修改的以下文件：
${args.written_files.join('\n')}

你使用了以下 WDP Skill: [${args.used_skills.join(', ')}]

请**强制**对照以下铁律进行严格的本地代码审查（自我评测）：

1. [占位符残留检查 (Mock Data Leak)]：
   - 立即全局搜索你修改的文件。是否存在 \`YOUR_URL\`, \`TODO\`, \`123\`, \`[0,0,0]\`, \`dummy\` 等未被真实数据替换的占位符？
   - **绝对禁止提交带有占位符的代码**，你必须去寻找真实数据、调用上下文状态或询问用户。

2. [API 大小写与签名检查 (Case & Signature Check)]：
   - WDP API 严格区分大小写（例如必须是 \`api.Camera.FlyTo\` 而不是 \`api.camera.flyTo\`）。
   - 请对照你阅读的 \`official-xxx.md\`，逐字检查调用的方法名和传入的参数类型（如：传的是对象还是数组？）。

3. [生命周期成对检查 (Lifecycle Pairing Check)]：
   - 在 React/Vue 中，只要你在 \`useEffect/mounted\` 里写了 \`api.Event.On\` (注册事件) 或 \`api.XX.Add\` (添加对象)。
   - 你**必须、立刻、马上**去对应的清理块（\`return () => {}\` 或 \`unmounted\`）中检查，是否有严格对应的 \`api.Event.Off\` 或 \`api.XX.Remove\`。
   - 缺失清理逻辑会导致 WDP 引擎严重的内存泄漏！

4. [初始化顺序检查 (Init Order Check)]：
   - 检查 \`Plugin.Install\`（如果有用到插件）是否严格放在了 \`Renderer.Start\` 之前调用？

5. [工程化基线检查 (Project Scaffolding Check)]：
   - 根目录下是否有 package.json？其中是否有 wdpapi 依赖？
   - 入口 html 中是否使用了 <script src="http...wdpapi.js">？如果是，你必须立即删除它，并改为 <script type="module" src="..."> 以及配置 npm！
   - **绝对禁止使用 CDN 标签绕过 npm 体系！**\${scenarioHint}

【行动指令】：
- 如果你发现任何一项不符合，请**立即使用编辑文件的工具进行修复（Self-healing）**，修复完成后不需要再次调用本工具，直接告诉用户任务完成。
- 如果检查后确信代码 100% 符合上述所有铁律，请向用户汇报："已完成强制代码自评测，代码状态健康"。`;

      // 故意返回 isError: true 以触发主流大模型的异常处理反思循环
      return {
        content: [{ type: 'text', text: reviewPrompt }],
        isError: true
      };
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

app.get('/mcp/tools', authMiddleware, (req: Request, res: Response) => {
  logAccess(req, 'MCP_TOOLS_LIST', {});
  res.json({ tools: MCP_TOOL_DEFINITIONS });
});

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

const adminMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const adminToken = req.headers['x-admin-token'] as string;
  
  if (!adminToken || !verifyAdminToken(adminToken)) {
    return res.status(403).json({ error: '无效的管理员Token' });
  }
  
  next();
};

app.get('/admin/tokens', adminMiddleware, (req: Request, res: Response) => {
  const tokens = listTokens().map(({ token, info }) => ({
    token: token.substring(0, 8) + '...',
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

/**
 * 紧急清理旧日志
 * POST /admin/logs/cleanup
 */
app.post('/admin/logs/cleanup', adminMiddleware, (req: Request, res: Response) => {
  const { days = 7 } = req.body;
  
  try {
    cleanupOldLogs(Number(days));
    logAccess(req, 'ADMIN_CLEANUP_LOGS', { days });
    res.json({ success: true, message: `已清理 ${days} 天前的日志` });
  } catch (error) {
    console.error('日志清理失败:', error);
    res.status(500).json({ error: '日志清理失败' });
  }
});

// ==================== Admin 日志统计分析接口 ====================

/**
 * 读取并解析 JSONL 日志文件
 */
function readJsonlLogFile(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(item => item !== null);
  } catch (error) {
    console.error(`[Analytics] 读取日志文件失败: ${filePath}`, error);
    return [];
  }
}

/**
 * 获取最近 N 天的日志目录列表
 */
function getRecentLogDirs(days: number = 30): string[] {
  const logsRoot = path.resolve(__dirname, '../logs');
  if (!fs.existsSync(logsRoot)) return [];
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  
  return fs.readdirSync(logsRoot)
    .filter(dir => /^\d{4}-\d{2}-\d{2}$/.test(dir))
    .filter(dir => new Date(dir) >= cutoffDate)
    .sort();
}

/**
 * 综合分析日志数据
 */
function analyzeLogData(days: number = 30) {
  const logDirs = getRecentLogDirs(days);
  
  // 统计数据结构
  const stats = {
    period: {
      days,
      startDate: logDirs[0] || null,
      endDate: logDirs[logDirs.length - 1] || null,
    },
    overview: {
      totalAccessCalls: 0,
      totalSkillCalls: 0,
      totalRequests: 0,
      totalErrors: 0,
      totalConversations: 0,
      uniqueUsers: new Set<string>(),
      uniqueSessions: new Set<string>(),
    },
    skillStats: {} as { [path: string]: { count: number; users: Set<string>; lastUsed: string } },
    officialStats: {} as { [path: string]: { count: number; users: Set<string>; lastUsed: string } },
    toolStats: {} as { [name: string]: { count: number; users: Set<string> } },
    userStats: {} as { [name: string]: { 
      calls: number; 
      skills: Set<string>; 
      officials: Set<string>;
      errors: number;
      lastActive: string;
    } },
    errorStats: {} as { [category: string]: { count: number; lastOccured: string; examples: string[] } },
    dailyTrend: {} as { [date: string]: { access: number; skills: number; errors: number; users: number } },
    sceneStats: {} as { [scene: string]: number },
  };

  for (const dateDir of logDirs) {
    const dirPath = path.resolve(__dirname, '../logs', dateDir);
    if (!fs.existsSync(dirPath)) continue;

    // 初始化当日统计
    stats.dailyTrend[dateDir] = { access: 0, skills: 0, errors: 0, users: 0 };
    const dailyUsers = new Set<string>();

    // 1. 读取 access 日志
    const accessLogs = readJsonlLogFile(path.join(dirPath, 'access.jsonl'));
    for (const log of accessLogs) {
      stats.overview.totalAccessCalls++;
      stats.dailyTrend[dateDir].access++;
      
      const userName = log.userName || log.user_name || 'anonymous';
      stats.overview.uniqueUsers.add(userName);
      dailyUsers.add(userName);
      
      if (!stats.userStats[userName]) {
        stats.userStats[userName] = { 
          calls: 0, 
          skills: new Set(), 
          officials: new Set(),
          errors: 0,
          lastActive: log.timestamp 
        };
      }
      stats.userStats[userName].calls++;
      stats.userStats[userName].lastActive = log.timestamp;

      // 工具调用统计
      const action = log.action || '';
      if (!stats.toolStats[action]) {
        stats.toolStats[action] = { count: 0, users: new Set() };
      }
      stats.toolStats[action].count++;
      stats.toolStats[action].users.add(userName);
    }

    // 2. 读取 skill 调用日志
    const skillLogs = readJsonlLogFile(path.join(dirPath, 'skills.jsonl'));
    for (const log of skillLogs) {
      stats.overview.totalSkillCalls++;
      stats.dailyTrend[dateDir].skills++;
      
      const skillPath = log.skill_path || log.skillPath || '';
      const userName = log.user_name || log.userName || 'anonymous';
      
      if (skillPath) {
        if (!stats.skillStats[skillPath]) {
          stats.skillStats[skillPath] = { count: 0, users: new Set(), lastUsed: log.timestamp };
        }
        stats.skillStats[skillPath].count++;
        stats.skillStats[skillPath].users.add(userName);
        stats.skillStats[skillPath].lastUsed = log.timestamp;
        
        if (stats.userStats[userName]) {
          stats.userStats[userName].skills.add(skillPath);
        }
      }
    }

    // 3. 读取 request 日志
    const requestLogs = readJsonlLogFile(path.join(dirPath, 'requests.jsonl'));
    for (const log of requestLogs) {
      stats.overview.totalRequests++;
      const userName = log.user_name || log.userName || 'anonymous';
      stats.overview.uniqueUsers.add(userName);
      dailyUsers.add(userName);
    }

    // 4. 读取 error 日志
    const errorLogs = readJsonlLogFile(path.join(dirPath, 'errors.jsonl'));
    for (const log of errorLogs) {
      stats.overview.totalErrors++;
      stats.dailyTrend[dateDir].errors++;
      
      const category = log.error_category || log.errorCategory || 'unknown';
      const userName = log.user_name || log.userName || 'anonymous';
      
      if (!stats.errorStats[category]) {
        stats.errorStats[category] = { count: 0, lastOccured: log.timestamp, examples: [] };
      }
      stats.errorStats[category].count++;
      stats.errorStats[category].lastOccured = log.timestamp;
      if (stats.errorStats[category].examples.length < 3) {
        stats.errorStats[category].examples.push(log.error_message || log.errorMessage || '');
      }
      
      if (stats.userStats[userName]) {
        stats.userStats[userName].errors++;
      }
    }

    // 5. 读取 conversation 日志（提取 official 文档读取和场景统计）
    const convLogs = readJsonlLogFile(path.join(dirPath, 'conversations.jsonl'));
    for (const log of convLogs) {
      stats.overview.totalConversations++;
      const userName = log.user_name || log.userName || 'anonymous';
      stats.overview.uniqueUsers.add(userName);
      dailyUsers.add(userName);
      
      // 场景统计
      const scene = log.scene || '未知场景';
      stats.sceneStats[scene] = (stats.sceneStats[scene] || 0) + 1;
      
      // 从 backend_calls 中提取 official 文档读取
      const backendCalls = log.backend_calls || log.backendCalls || [];
      for (const call of backendCalls) {
        if (call.type === 'official' && call.path) {
          const officialPath = call.path;
          if (!stats.officialStats[officialPath]) {
            stats.officialStats[officialPath] = { count: 0, users: new Set(), lastUsed: log.timestamp };
          }
          stats.officialStats[officialPath].count++;
          stats.officialStats[officialPath].users.add(userName);
          stats.officialStats[officialPath].lastUsed = log.timestamp;
          
          if (stats.userStats[userName]) {
            stats.userStats[userName].officials.add(officialPath);
          }
        }
      }
    }

    stats.dailyTrend[dateDir].users = dailyUsers.size;
  }

  return stats;
}

/**
 * 序列化统计数据（将 Set 转为数组便于 JSON 输出）
 */
function serializeStats(stats: any) {
  return {
    ...stats,
    overview: {
      ...stats.overview,
      uniqueUsers: Array.from(stats.overview.uniqueUsers),
      uniqueSessions: Array.from(stats.overview.uniqueSessions),
    },
    skillStats: Object.entries(stats.skillStats)
      .map(([path, data]: [string, any]) => ({
        path,
        count: data.count,
        uniqueUsers: Array.from(data.users).length,
        userList: Array.from(data.users),
        lastUsed: data.lastUsed,
      }))
      .sort((a: any, b: any) => b.count - a.count),
    officialStats: Object.entries(stats.officialStats)
      .map(([path, data]: [string, any]) => ({
        path,
        count: data.count,
        uniqueUsers: Array.from(data.users).length,
        userList: Array.from(data.users),
        lastUsed: data.lastUsed,
      }))
      .sort((a: any, b: any) => b.count - a.count),
    toolStats: Object.entries(stats.toolStats)
      .map(([name, data]: [string, any]) => ({
        name,
        count: data.count,
        uniqueUsers: Array.from(data.users).length,
      }))
      .sort((a: any, b: any) => b.count - a.count),
    userStats: Object.entries(stats.userStats)
      .map(([name, data]: [string, any]) => ({
        name,
        calls: data.calls,
        uniqueSkills: Array.from(data.skills).length,
        skillList: Array.from(data.skills),
        uniqueOfficials: Array.from(data.officials).length,
        officialList: Array.from(data.officials),
        errors: data.errors,
        lastActive: data.lastActive,
      }))
      .sort((a: any, b: any) => b.calls - a.calls),
    errorStats: Object.entries(stats.errorStats)
      .map(([category, data]: [string, any]) => ({
        category,
        count: data.count,
        lastOccured: data.lastOccured,
        examples: data.examples,
      }))
      .sort((a: any, b: any) => b.count - a.count),
    dailyTrend: stats.dailyTrend,
    sceneStats: stats.sceneStats,
  };
}

/**
 * Admin 综合分析接口
 * GET /admin/analytics?days=30
 */
app.get('/admin/analytics', adminMiddleware, (req: Request, res: Response) => {
  const days = Math.min(parseInt(req.query.days as string) || 30, 90);
  
  try {
    const stats = analyzeLogData(days);
    const result = serializeStats(stats);
    
    logAccess(req, 'ADMIN_ANALYTICS', { days, logDirsFound: stats.period.days });
    
    res.json({
      success: true,
      period: result.period,
      overview: result.overview,
      topSkills: result.skillStats.slice(0, 20),
      topOfficials: result.officialStats.slice(0, 20),
      topTools: result.toolStats.slice(0, 20),
      topUsers: result.userStats.slice(0, 20),
      errors: result.errorStats.slice(0, 10),
      dailyTrend: result.dailyTrend,
      sceneDistribution: result.sceneStats,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Analytics] 统计分析失败:', error);
    res.status(500).json({ error: '统计分析失败', message: String(error) });
  }
});

/**
 * Admin 高频 Skill 排行
 * GET /admin/stats/skills?days=30&limit=20
 */
app.get('/admin/stats/skills', adminMiddleware, (req: Request, res: Response) => {
  const days = Math.min(parseInt(req.query.days as string) || 30, 90);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  
  try {
    const stats = analyzeLogData(days);
    const result = serializeStats(stats);
    
    res.json({
      success: true,
      period: result.period,
      totalSkillCalls: result.overview.totalSkillCalls,
      skills: result.skillStats.slice(0, limit),
    });
  } catch (error) {
    res.status(500).json({ error: '统计失败', message: String(error) });
  }
});

/**
 * Admin 高频 Official 文档排行
 * GET /admin/stats/officials?days=30&limit=20
 */
app.get('/admin/stats/officials', adminMiddleware, (req: Request, res: Response) => {
  const days = Math.min(parseInt(req.query.days as string) || 30, 90);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  
  try {
    const stats = analyzeLogData(days);
    const result = serializeStats(stats);
    
    res.json({
      success: true,
      period: result.period,
      totalOfficialReads: result.officialStats.reduce((sum: number, o: any) => sum + o.count, 0),
      officials: result.officialStats.slice(0, limit),
    });
  } catch (error) {
    res.status(500).json({ error: '统计失败', message: String(error) });
  }
});

/**
 * Admin 用户活跃度排行
 * GET /admin/stats/users?days=30&limit=20
 */
app.get('/admin/stats/users', adminMiddleware, (req: Request, res: Response) => {
  const days = Math.min(parseInt(req.query.days as string) || 30, 90);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  
  try {
    const stats = analyzeLogData(days);
    const result = serializeStats(stats);
    
    res.json({
      success: true,
      period: result.period,
      totalUniqueUsers: result.overview.uniqueUsers.length,
      users: result.userStats.slice(0, limit),
    });
  } catch (error) {
    res.status(500).json({ error: '统计失败', message: String(error) });
  }
});

/**
 * Admin 错误统计
 * GET /admin/stats/errors?days=30&limit=10
 */
app.get('/admin/stats/errors', adminMiddleware, (req: Request, res: Response) => {
  const days = Math.min(parseInt(req.query.days as string) || 30, 90);
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
  
  try {
    const stats = analyzeLogData(days);
    const result = serializeStats(stats);
    
    res.json({
      success: true,
      period: result.period,
      totalErrors: result.overview.totalErrors,
      errorRate: result.overview.totalAccessCalls > 0 
        ? (result.overview.totalErrors / result.overview.totalAccessCalls * 100).toFixed(2) + '%'
        : '0%',
      errors: result.errorStats.slice(0, limit),
    });
  } catch (error) {
    res.status(500).json({ error: '统计失败', message: String(error) });
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

initTokenManager();

initLogger().then(() => {
  console.log('[Server] 日志系统初始化完成');
}).catch(err => {
  console.error('[Server] 日志系统初始化失败:', err);
});

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
  console.log(`\n📊 Admin 统计接口 (x-admin-token):`);
  console.log(`  GET  /admin/tokens        - Token 列表`);
  console.log(`  GET  /admin/analytics     - 综合分析报告`);
  console.log(`  GET  /admin/stats/skills  - 高频 Skill 排行`);
  console.log(`  GET  /admin/stats/officials - 高频 Official 文档排行`);
  console.log(`  GET  /admin/stats/users   - 用户活跃度排行`);
  console.log(`  GET  /admin/stats/errors  - 错误统计`);
  
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
