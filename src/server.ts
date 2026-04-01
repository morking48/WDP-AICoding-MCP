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

/**
 * 读取知识文件
 */
const readKnowledgeFile = (skillPath: string): string | null => {
  const fullPath = path.resolve(KNOWLEDGE_BASE_PATH, skillPath);
  
  // 安全检查：确保路径在知识库范围内
  if (!fullPath.startsWith(KNOWLEDGE_BASE_PATH)) {
    return null;
  }
  
  try {
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    return null;
  } catch (error) {
    console.error('读取文件失败:', error);
    return null;
  }
};

/**
 * 搜索知识库
 */
const searchKnowledge = (query: string): Array<{path: string, preview: string}> => {
  const results: Array<{path: string, preview: string}> = [];
  
  const searchDir = (dir: string, basePath: string = '') => {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const relativePath = path.join(basePath, item);
      
      if (fs.statSync(fullPath).isDirectory()) {
        searchDir(fullPath, relativePath);
      } else if (item.endsWith('.md') || item.endsWith('.json')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            path: relativePath,
            preview: content.substring(0, 200) + '...'
          });
        }
      }
    }
  };
  
  try {
    searchDir(KNOWLEDGE_BASE_PATH);
  } catch (error) {
    console.error('搜索失败:', error);
  }
  
  return results;
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
  
  const content = readKnowledgeFile(skillPath);
  
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
  
  logAccess(req, 'QUERY_KNOWLEDGE', { query, skill_path });
  
  // 如果指定了具体路径，检查权限
  if (skill_path && typeof skill_path === 'string') {
    // 检查是否为敏感路径
    if (isSensitivePath(skill_path)) {
      logAccess(req, 'ACCESS_DENIED', { path: skill_path, reason: '敏感资源' });
      return res.status(403).json({ 
        error: '无权访问该资源',
        message: '该资源受到保护，无法访问'
      });
    }
    
    const content = readKnowledgeFile(skill_path);
    if (content) {
      return res.json({
        success: true,
        type: 'direct',
        path: skill_path,
        content,
        timestamp: new Date().toISOString()
      });
    }
  }
  
  // 否则执行搜索
  const results = searchKnowledge(query);
  
  res.json({
    success: true,
    type: 'search',
    query,
    results,
    resultCount: results.length,
    timestamp: new Date().toISOString()
  });
});

/**
 * 列出所有可用技能
 * GET /api/skills
 */
app.get('/api/skills', authMiddleware, (req: Request, res: Response) => {
  const listSkills = (dir: string, basePath: string = ''): any[] => {
    const items: any[] = [];
    
    try {
      const entries = fs.readdirSync(dir);
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relativePath = path.join(basePath, entry);
        
        if (fs.statSync(fullPath).isDirectory()) {
          const children = listSkills(fullPath, relativePath);
          
          // 检查是否是技能目录（包含 SKILL.md）
          const hasSkill = fs.existsSync(path.join(fullPath, 'SKILL.md'));
          
          items.push({
            name: entry,
            path: relativePath,
            type: 'directory',
            isSkill: hasSkill,
            children: children.length > 0 ? children : undefined
          });
        } else if (entry.endsWith('.md')) {
          items.push({
            name: entry,
            path: relativePath,
            type: 'file'
          });
        }
      }
    } catch (error) {
      console.error('列出技能失败:', error);
    }
    
    return items;
  };
  
  logAccess(req, 'LIST_SKILLS', {});
  
  const skills = listSkills(KNOWLEDGE_BASE_PATH);
  
  res.json({
    success: true,
    skills,
    timestamp: new Date().toISOString()
  });
});

// ============ MCP 代理端点 ============

// 工具定义（从 mcp-remote-client.js 迁移到服务器端）
const MCP_TOOLS = [
  {
    name: 'start_wdp_workflow',
    description: '【WDP开发入口 - 必须首先调用】当用户有任何WDP相关需求时，第一时间调用此工具启动工作流。' +
      '触发场景包括：WDP、数字孪生、3D可视化、三维场景、BIM、建筑信息模型、GIS、地理信息、地图应用、' +
      '大屏展示、数据可视化、场景渲染、3D模型、数字沙盘、智慧园区、智慧建筑、' +
      '模型展示、楼层管理、空间数据、实体管理、相机漫游、视角控制、' +
      '覆盖物标注、事件交互、图层控制、材质设置、点聚合、' +
      '模型高亮、构件查看、空间测量、视频融合、' +
      '"写一个展示大楼的页面"、"做个地图系统"、"3D可视化大屏"等。' +
      '【工作流顺序 - 严格执行】' +
      '第1步：使用 get_skill_content 读取 wdp-entry-agent/SKILL.md（入口路由判断 - 触发词：加载WDP相关skill）' +
      '第2步：使用 get_skill_content 读取 wdp-intent-orchestrator/SKILL.md（需求分析编排 - 触发词：分析需求）' +
      '第3步：根据分析结果查询具体技能实现。' +
      '严禁跳过步骤或颠倒顺序！',
    inputSchema: {
      type: 'object',
      properties: {
        user_requirement: {
          type: 'string',
          description: '用户的原始需求描述，例如："帮我写一个显示3D大楼的页面"。调用后必须按顺序读取 wdp-entry-agent 和 wdp-intent-orchestrator'
        }
      },
      required: ['user_requirement']
    }
  },
  {
    name: 'query_knowledge',
    description: '查询 WDP 知识库，获取指定技能或路由的文档内容。' +
      '在执行 start_wdp_workflow 后，根据返回的技能路由路径，使用此工具查询具体的技术实现细节。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '查询关键词或问题描述'
        },
        skill_path: {
          type: 'string',
          description: '可选：指定技能路径，如 "wdp-api-camera-unified/SKILL.md"'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_skill_content',
    description: '获取指定技能文件的完整内容。' +
      '当需要深入阅读某个技能的完整文档时使用，例如获取 wdp-entry-agent 或 wdp-intent-orchestrator 的完整内容。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '技能文件路径，如 "wdp-entry-agent/SKILL.md"'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'list_skills',
    description: '列出所有可用的 WDP 技能和文档，用于了解知识库中有哪些技能可用',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'check_health',
    description: '检查远程知识引擎的健康状态',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

/**
 * 处理 start_wdp_workflow 工具调用
 */
function handleStartWdpWorkflow(args: any, token?: string) {
  if (!args || typeof args.user_requirement !== 'string') {
    throw new Error('缺少 user_requirement 参数');
  }
  
  // 返回完整工作流
  return {
    title: '🔥 WDP 开发工作流启动',
    user_requirement: args.user_requirement,
    workflow_steps: [
      {
        step: 1,
        name: '入口路由判断',
        action: '读取 wdp-entry-agent/SKILL.md',
        description: '执行强制性检查点，完成路由判断和基线检查（触发词：加载WDP相关skill）',
        tool_call: {
          tool: 'get_skill_content',
          path: 'wdp-entry-agent/SKILL.md'
        }
      },
      {
        step: 2,
        name: '意图编排与需求分析',
        action: '读取 wdp-intent-orchestrator/SKILL.md',
        description: '解析用户混沌需求，推导隐藏模块，输出《系统意图与架构设计报告》（触发词：分析需求）',
        tool_call: {
          tool: 'get_skill_content',
          path: 'wdp-intent-orchestrator/SKILL.md'
        }
      },
      {
        step: 3,
        name: '获取基础骨架',
        action: '读取 universal-bootstrap 模板文件',
        description: '读取基础骨架模板作为代码生成基础',
        tool_calls: [
          { tool: 'get_skill_content', path: 'official_api_code_example/universal-bootstrap.template.html' },
          { tool: 'get_skill_content', path: 'official_api_code_example/universal-bootstrap.template.main.js' },
          { tool: 'get_skill_content', path: 'official_api_code_example/universal-bootstrap.template.package.json' }
        ]
      },
      {
        step: 4,
        name: '查询具体技能实现',
        action: '根据路由结果查询对应技能',
        description: '根据需求类型查询具体技能文档。技能分类：BIM/GIS/相机/事件/实体/覆盖物/图层/初始化/点聚合/功能组件/属性/材质/空间理解/CSS管理',
        skill_mapping: {
          'BIM模型操作': 'wdp-api-bim-unified/SKILL.md',
          'GIS核心操作': 'gis-api-core-operations/SKILL.md',
          '相机控制': 'wdp-api-camera-unified/SKILL.md',
          '事件注册交互': 'wdp-api-general-event-registration/SKILL.md',
          '实体通用行为': 'wdp-api-entity-general-behavior/SKILL.md',
          '覆盖物管理': 'wdp-api-coverings-unified/SKILL.md',
          '图层模型Tiles': 'wdp-api-layer-models/SKILL.md',
          '场景初始化': 'wdp-api-initialization-unified/SKILL.md',
          '点聚合Cluster': 'wdp-api-cluster/SKILL.md',
          '功能组件特效': 'wdp-api-function-components/SKILL.md',
          '实体属性操作': 'wdp-api-generic-base-attributes/SKILL.md',
          '材质设置高亮': 'wdp-api-material-settings/SKILL.md',
          '空间理解坐标转换': 'wdp-api-spatial-understanding/SKILL.md',
          'CSS层叠管理': 'wdp-css-layer-management/SKILL.md'
        },
        examples: [
          { scenario: 'BIM模型操作、构件高亮、房间高亮', path: 'wdp-api-bim-unified/SKILL.md' },
          { scenario: 'GIS核心操作、地图、地理信息', path: 'gis-api-core-operations/SKILL.md' },
          { scenario: '相机控制、视角漫游、相机位置', path: 'wdp-api-camera-unified/SKILL.md' },
          { scenario: '事件注册、事件监听、交互回调', path: 'wdp-api-general-event-registration/SKILL.md' },
          { scenario: '实体行为、实体高亮、实体描边', path: 'wdp-api-entity-general-behavior/SKILL.md' },
          { scenario: '覆盖物、标注、信息窗', path: 'wdp-api-coverings-unified/SKILL.md' },
          { scenario: '图层模型、Tiles、AES底板', path: 'wdp-api-layer-models/SKILL.md' },
          { scenario: '场景初始化、渲染器启动', path: 'wdp-api-initialization-unified/SKILL.md' },
          { scenario: '点聚合Cluster、数据聚合、周边搜索', path: 'wdp-api-cluster/SKILL.md' },
          { scenario: '功能组件、天气、水面、天空盒、粒子特效、后处理', path: 'wdp-api-function-components/SKILL.md' },
          { scenario: '实体属性、属性读写、批量更新', path: 'wdp-api-generic-base-attributes/SKILL.md' },
          { scenario: '材质设置、材质替换、材质高亮、模型高亮', path: 'wdp-api-material-settings/SKILL.md' },
          { scenario: '空间理解、坐标转换、取点交互、GIS坐标', path: 'wdp-api-spatial-understanding/SKILL.md' },
          { scenario: 'CSS层叠管理、z-index、pointer-events、UI层级', path: 'wdp-css-layer-management/SKILL.md' }
        ]
      },
      {
        step: 5,
        name: '状态管理配置',
        action: '读取 wdp-context-memory 规范',
        description: '了解状态管理基线，确保跨域基础设施正确配置',
        tool_calls: [
          { tool: 'get_skill_content', path: 'wdp-context-memory/INTEGRATION_SPEC.md' },
          { tool: 'get_skill_content', path: 'wdp-context-memory/MEMORY_SCHEMA.json' }
        ]
      },
      {
        step: 6,
        name: '代码生成与验证',
        action: '生成可执行代码',
        description: '按照工作流指导生成代码，确保：1)使用 new WdpApi() 初始化 2)Plugin.Install 安装插件 3)Renderer.Start 启动渲染器',
        checklist: [
          '✅ 服务器 URL 和验证口令已确认（非假值）',
          '✅ 渲染容器 DOM ID 已指定',
          '✅ 所需插件已安装（BIM/GIS等）',
          '✅ 事件监听已注册',
          '✅ 清理机制已考虑（Destroy/Clear）'
        ]
      }
    ],
    important_notes: [
      '⚠️ 严禁使用 "YOUR_URL" 等假值，必须向用户确认真实参数',
      '⚠️ 所有配置必须提取到文件最顶部，标记为"用户配置区"',
      '⚠️ 关键节点必须包含 UI 提示（alert 或页面输出），不能仅依赖 console',
      '⚠️ 每 3-5 步执行 ValidateConsistency 校验状态一致性'
    ],
    next_action: '请立即执行 Step 1：使用 get_skill_content 工具读取 wdp-entry-agent/SKILL.md 开始入口路由判断'
  };
}

/**
 * MCP 工具调用处理
 */
async function handleMcpToolCall(name: string, args: any, req: Request): Promise<any> {
  // 获取请求中的token进行权限检查
  const requestToken = (req as any).userToken;
  
  switch (name) {
    case 'start_wdp_workflow': {
      const result = handleStartWdpWorkflow(args, requestToken);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }

    case 'query_knowledge': {
      if (!args || typeof args.query !== 'string') {
        throw new Error('缺少 query 参数');
      }
      
      // 如果指定了具体路径，检查权限
      if (args.skill_path && typeof args.skill_path === 'string') {
        // 检查是否为敏感路径
        if (isSensitivePath(args.skill_path)) {
          return {
            content: [{ type: 'text', text: '错误: 无权访问该资源' }],
            isError: true
          };
        }
        
        const content = readKnowledgeFile(args.skill_path);
        if (content) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              success: true,
              type: 'direct',
              path: args.skill_path,
              content,
              timestamp: new Date().toISOString()
            }, null, 2) }]
          };
        }
      }
      
      // 复用现有的搜索逻辑
      const results = searchKnowledge(args.query);
      
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          type: 'search',
          query: args.query,
          results,
          resultCount: results.length,
          timestamp: new Date().toISOString()
        }, null, 2) }]
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
      
      const content = readKnowledgeFile(args.path);
      
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
      const skills = listAllSkills(KNOWLEDGE_BASE_PATH);
      
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true,
          skills,
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

/**
 * 列出所有可用技能（复用逻辑）
 */
const listAllSkills = (dir: string, basePath: string = ''): any[] => {
  const items: any[] = [];
  
  try {
    if (!fs.existsSync(dir)) {
      return items;
    }
    
    const entries = fs.readdirSync(dir);
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const relativePath = path.join(basePath, entry);
      
      if (fs.statSync(fullPath).isDirectory()) {
        const children = listAllSkills(fullPath, relativePath);
        
        // 检查是否是技能目录（包含 SKILL.md）
        const hasSkill = fs.existsSync(path.join(fullPath, 'SKILL.md'));
        
        items.push({
          name: entry,
          path: relativePath,
          type: 'directory',
          isSkill: hasSkill,
          children: children.length > 0 ? children : undefined
        });
      } else if (entry.endsWith('.md')) {
        items.push({
          name: entry,
          path: relativePath,
          type: 'file'
        });
      }
    }
  } catch (error) {
    console.error('列出技能失败:', error);
  }
  
  return items;
};

// MCP 代理端点：获取工具定义
app.get('/mcp/tools', authMiddleware, (req: Request, res: Response) => {
  logAccess(req, 'MCP_TOOLS_LIST', {});
  res.json({ tools: MCP_TOOLS });
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
