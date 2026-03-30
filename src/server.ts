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
  cleanupOldLogs 
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
  canQuerySkillDetail,
  canQueryGuide,
  getRecommendedPath,
  isTokenDisabled,
  getTokenPermissionDescription
} from './utils/tokenManager';

// 配置
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';  // 默认监听所有网络接口，支持远程访问

// Token权限配置：公开Token只能访问official，私有Token可以访问全部
const TOKEN_PERMISSIONS: { [token: string]: { type: 'public' | 'private'; name: string } } = {};

// 从环境变量加载Token配置
// 格式：VALID_TOKENS=token1:public:名称1,token2:private:名称2
const rawTokens = process.env.VALID_TOKENS || 'demo-token:private:管理员';
const VALID_TOKENS: string[] = [];

rawTokens.split(',').forEach(tokenConfig => {
  const [token, type, name] = tokenConfig.split(':');
  if (token && type) {
    TOKEN_PERMISSIONS[token] = { 
      type: type as 'public' | 'private', 
      name: name || '未命名用户' 
    };
    VALID_TOKENS.push(token);
  }
});

const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH 
  ? path.resolve(process.env.KNOWLEDGE_BASE_PATH)
  : path.resolve(__dirname, '../../skills');
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
  // 获取或创建会话ID
  const sessionId = getOrCreateSessionId(req.ip || 'unknown');
  
  // 获取用户信息
  const userInfo = (req as any).userInfo;
  const userToken = (req as any).userToken;
  const tokenType = userInfo?.type || 'unknown';
  const userName = userInfo?.name || 'anonymous';
  
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
          tokenType,
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
        context: { tokenType, userName },
        recoverable: false,
        userImpact: 'User cannot access system'
      });
      break;
  }
  
  // 增强版访问日志
  const logEntry = {
    timestamp: new Date().toISOString(),
    ip: req.ip,
    action,
    userAgent: req.headers['user-agent'],
    sessionId,
    userName,
    tokenType,
    responseTimeMs: Date.now() - startTime,
    ...data
  };
  
  const logLine = JSON.stringify(logEntry) + '\n';
  fs.appendFileSync(LOGS_PATH, logLine);
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
  
  // 检查是否是skill详细内容（SKILL.md文件）
  const isSkillDetail = skillPath.endsWith('SKILL.md') || skillPath.endsWith('skill.md');
  
  // 如果是skill详细内容，检查是否有权限
  if (isSkillDetail && !canQuerySkillDetail(token)) {
    logAccess(req, 'ACCESS_DENIED', { path: skillPath, reason: '公开用户不能查询skill详细内容' });
    return res.status(403).json({ 
      error: '无权访问详细内容',
      message: '体验用户可查看所有功能，但无法查询技术实现细节。如需完整访问权限，请联系管理员升级为正式用户。',
      upgradeInfo: {
        current: '体验用户（public）',
        upgradeTo: '正式用户（private）',
        contact: '请联系管理员获取完整访问权限'
      }
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
    // 检查是否是skill详细内容
    const isSkillDetail = skill_path.endsWith('SKILL.md') || skill_path.endsWith('skill.md');
    
    if (isSkillDetail && !canQuerySkillDetail(token)) {
      logAccess(req, 'ACCESS_DENIED', { path: skill_path, reason: '公开用户不能查询skill详细内容' });
      return res.status(403).json({ 
        error: '无权访问详细内容',
        message: '体验用户可查看所有功能，但无法查询技术实现细节。如需完整访问权限，请联系管理员升级为正式用户。',
        upgradeInfo: {
          current: '体验用户（public）',
          upgradeTo: '正式用户（private）',
          contact: '请联系管理员获取完整访问权限'
        }
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
 * 根据token类型返回不同的工作流指导
 */
function handleStartWdpWorkflow(args: any, token?: string) {
  if (!args || typeof args.user_requirement !== 'string') {
    throw new Error('缺少 user_requirement 参数');
  }
  
  // 判断token类型
  const isPrivate = token ? canQuerySkillDetail(token) : false;
  const entryPath = isPrivate ? 'wdp-entry-agent/SKILL.md' : 'wdp-entry-agent/GUIDE.md';
  const intentPath = isPrivate ? 'wdp-intent-orchestrator/SKILL.md' : 'wdp-intent-orchestrator/GUIDE.md';
  
  // 根据token类型返回不同的工作流
  if (!isPrivate) {
    // Public/商业用户：返回简化版工作流
    return {
      title: '🔥 WDP 开发工作流启动（商业用户版）',
      user_requirement: args.user_requirement,
      notice: '【重要】您当前使用的是商业用户权限，可以获得WDP功能使用指导，但无法查看完整技术实现细节。',
      workflow_steps: [
        {
          step: 1,
          name: '入口路由判断',
          action: `读取 ${entryPath}`,
          description: '获取WDP入口路由判断指南（使用说明版）',
          tool_call: {
            tool: 'get_skill_content',
            path: entryPath
          },
          fallback: '如果GUIDE.md不存在，请联系管理员获取使用权限'
        },
        {
          step: 2,
          name: '意图编排与需求分析',
          action: `读取 ${intentPath}`,
          description: '获取需求分析指导（使用说明版）',
          tool_call: {
            tool: 'get_skill_content',
            path: intentPath
          }
        },
        {
          step: 3,
          name: '获取实现方案',
          action: '联系管理员或升级权限',
          description: '商业用户可通过AI助手使用WDP功能，如需查看完整技术实现，请联系管理员升级为内部用户权限',
          contact_info: {
            message: '如需完整技术文档访问权限，请联系管理员',
            current_level: '商业用户（public）',
            upgrade_to: '内部用户（private）'
          }
        }
      ],
      important_notes: [
        '✅ 商业用户可以通过AI助手使用WDP所有功能',
        '✅ 可以获得功能使用指导和最佳实践建议',
        '⚠️ 无法查看SKILL.md中的完整技术实现代码',
        '⚠️ 无法直接复制技术实现细节',
        '💡 如需升级权限，请联系管理员'
      ],
      next_action: `请执行 Step 1：使用 get_skill_content 工具读取 ${entryPath} 获取入口指导`
    };
  }
  
  // Private/内部用户：返回完整工作流
  return {
    title: '🔥 WDP 开发工作流启动（内部用户版）',
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
        description: '根据需求类型（BIM/GIS/相机/事件等）查询具体技能文档',
        examples: [
          { scenario: 'BIM相关', path: 'wdp-api-bim-unified/SKILL.md' },
          { scenario: 'GIS相关', path: 'gis-api-core-operations/SKILL.md' },
          { scenario: '相机控制', path: 'wdp-api-camera-unified/SKILL.md' },
          { scenario: '事件交互', path: 'wdp-api-general-event-registration/SKILL.md' },
          { scenario: '实体管理', path: 'wdp-api-entity-general-behavior/SKILL.md' },
          { scenario: '覆盖物', path: 'wdp-api-coverings-unified/SKILL.md' },
          { scenario: '图层模型', path: 'wdp-api-layer-models/SKILL.md' },
          { scenario: '初始化', path: 'wdp-api-initialization-unified/SKILL.md' }
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
        const isSkillDetail = args.skill_path.endsWith('SKILL.md') || args.skill_path.endsWith('skill.md');
        
        if (isSkillDetail && !canQuerySkillDetail(requestToken)) {
          return {
            content: [{ type: 'text', text: '错误: 体验用户无法查看技术实现细节。如需完整访问权限，请联系管理员升级为正式用户。' }],
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
      
      // 检查是否是skill详细内容（SKILL.md文件）
      const isSkillDetail = args.path.endsWith('SKILL.md') || args.path.endsWith('skill.md');
      
      // 如果是skill详细内容，检查是否有权限
      if (isSkillDetail && !canQuerySkillDetail(requestToken)) {
        return {
          content: [{ type: 'text', text: '错误: 体验用户无法查看技术实现细节。如需完整访问权限，请联系管理员升级为正式用户。' }],
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
    type: info.type,
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
  const { token, type, name } = req.body;
  
  if (!token || !type || !name) {
    return res.status(400).json({ error: '缺少必要参数：token, type, name' });
  }
  
  if (type !== 'public' && type !== 'private') {
    return res.status(400).json({ error: 'type必须是 public 或 private' });
  }
  
  const success = addToken(token, type, name);
  
  if (!success) {
    return res.status(409).json({ error: 'Token已存在' });
  }
  
  logAccess(req, 'ADMIN_ADD_TOKEN', { name, type });
  
  res.json({
    success: true,
    message: `Token添加成功: ${name} (${type})`,
    token: token.substring(0, 8) + '...'
  });
});

/**
 * 更新Token权限
 * PUT /admin/tokens/:token
 */
app.put('/admin/tokens/:token', adminMiddleware, (req: Request, res: Response) => {
  const { token } = req.params;
  const { type, name } = req.body;
  
  const success = updateToken(token, { type, name });
  
  if (!success) {
    return res.status(404).json({ error: 'Token不存在' });
  }
  
  logAccess(req, 'ADMIN_UPDATE_TOKEN', { token: token.substring(0, 8) + '...', type, name });
  
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
  console.log(`\n认证方式: Bearer Token`);
  console.log(`有效 Token: ${VALID_TOKENS.join(', ')}`);
});
