#!/usr/bin/env node
/**
 * WDP MCP 代理客户端 - 极简版
 * 
 * 这是一个智能代理，只负责桥接 Cline 和远程服务器。
 * 所有业务逻辑都在服务器端，客户端永远不需要更新！
 * 
 * 使用方法:
 * 1. 设置环境变量 WDP_SERVER_URL（服务器地址）
 * 2. 在 Cline 中配置指向这个文件
 * 3. 代理会自动从服务器获取最新工具定义和处理逻辑
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// 本地缓存模块
const { initCache, getCacheDir } = require('./cachePrompt');
const { LocalCacheManager } = require('./localCacheManager');
const path = require('path');
const fs = require('fs');

// 配置
const SERVER_URL = process.env.WDP_SERVER_URL || 'http://localhost:3000';
const TOKEN = process.env.WDP_KNOWLEDGE_TOKEN || 'demo-token';

// 缓存工具定义（减少网络请求）
let toolsCache = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 60秒缓存

// 本地缓存管理器
let localCacheManager = null;
let currentCacheDir = null;

/**
 * 根据工程路径初始化或切换缓存
 */
function initCacheForProject(projectPath) {
  if (!projectPath) {
    // 使用默认缓存
    const defaultCache = getCacheDir() || initCache();
    if (defaultCache !== currentCacheDir) {
      currentCacheDir = defaultCache;
      localCacheManager = new LocalCacheManager(currentCacheDir);
      console.error(`[代理] 使用默认缓存: ${currentCacheDir}`);
    }
    return currentCacheDir;
  }
  
  // 使用指定工程路径
  const projectCacheDir = path.join(projectPath, '.wdp-cache');
  
  // 确保目录存在
  if (!fs.existsSync(projectCacheDir)) {
    fs.mkdirSync(projectCacheDir, { recursive: true });
    console.error(`[代理] 创建工程缓存: ${projectCacheDir}`);
  }
  
  // 如果缓存目录变化，重新初始化
  if (projectCacheDir !== currentCacheDir) {
    currentCacheDir = projectCacheDir;
    localCacheManager = new LocalCacheManager(currentCacheDir);
    console.error(`[代理] 切换到工程缓存: ${currentCacheDir}`);
  }
  
  return currentCacheDir;
}

/**
 * 从服务器获取工具定义
 */
async function fetchToolsFromServer() {
  // 检查缓存
  if (toolsCache && Date.now() - cacheTime < CACHE_TTL) {
    return toolsCache;
  }

  try {
    const response = await fetch(`${SERVER_URL}/mcp/tools`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });

    if (!response.ok) {
      throw new Error(`获取工具定义失败: ${response.status}`);
    }

    const data = await response.json();
    toolsCache = data.tools;
    cacheTime = Date.now();
    
    console.error(`[代理] 已从服务器获取 ${toolsCache.length} 个工具定义`);
    return toolsCache;
  } catch (error) {
    console.error('[代理] 获取工具定义失败:', error.message);
    // 如果有缓存，返回缓存（即使过期）
    if (toolsCache) {
      console.error('[代理] 使用缓存的工具定义');
      return toolsCache;
    }
    throw error;
  }
}

/**
 * 处理 get_skill_content 工具调用（带本地缓存）
 */
async function handleGetSkillContent(args) {
  const skillPath = args.path;
  
  // 1. 检查本地缓存
  const cached = await localCacheManager.getSkill(skillPath);
  
  if (cached) {
    console.error(`[代理] 使用本地缓存: ${skillPath}`);
    // 返回缓存的摘要
    return {
      content: [{ 
        type: 'text', 
        text: JSON.stringify({
          fromCache: true,
          digest: cached.digest,
          fileHash: cached.fileHash,
          path: skillPath,
          lastAccessed: cached.lastAccessed
        }, null, 2)
      }]
    };
  }
  
  // 2. 本地无缓存，请求服务器
  console.error(`[代理] 请求服务器: ${skillPath}`);
  const result = await forwardToolCallToServer('get_skill_content', args);
  
  // 3. 解析服务器返回
  let serverData;
  try {
    const text = result.content[0].text;
    serverData = JSON.parse(text);
  } catch (error) {
    // 解析失败，直接返回原始结果
    return result;
  }
  
  // 4. 保存到本地缓存
  if (serverData.digest && serverData.fileHash) {
    await localCacheManager.setSkill(skillPath, {
      digest: serverData.digest,
      fileHash: serverData.fileHash
    });
    console.error(`[代理] 已保存到本地缓存: ${skillPath}`);
  }
  
  // 5. 返回给调用方（包含完整内容）
  return result;
}

/**
 * 转发工具调用到服务器
 */
async function forwardToolCallToServer(name, args) {
  const response = await fetch(`${SERVER_URL}/mcp/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ name, arguments: args })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`工具调用失败: ${response.status} - ${error}`);
  }

  return await response.json();
}

/**
 * 创建 MCP Server
 */
function createMCPServer() {
  const server = new Server(
    {
      name: 'wdp-mcp-proxy-client',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 处理工具列表请求 - 从服务器获取
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await fetchToolsFromServer();
    return { tools };
  });

  // 处理工具调用请求 - 转发到服务器
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      console.error(`[代理] 转发工具调用: ${name}`);
      console.error(`[代理] 参数: ${JSON.stringify(args)}`);
      
      // 获取工程路径（支持多种方式）
      let projectPath = args.projectPath;
      
      // 如果没有直接传递，尝试从 user_requirement 中提取
      if (!projectPath && args.user_requirement) {
        // 匹配 "projectPath: xxx" 或 "工程路径：xxx" 格式
        const match = args.user_requirement.match(/(?:projectPath|工程路径)[:：]\s*(.+?)(?:\n|$)/i);
        if (match) {
          projectPath = match[1].trim();
          console.error(`[代理] 从 user_requirement 提取工程路径: ${projectPath}`);
        }
      }
      
      // 初始化缓存
      if (projectPath) {
        console.error(`[代理] 使用工程路径: ${projectPath}`);
        initCacheForProject(projectPath);
      } else {
        console.error(`[代理] 警告: 未指定工程路径`);
      }
      
      // 将 projectPath 添加到参数中（如果提取到了）
      const modifiedArgs = { ...args };
      if (projectPath && !modifiedArgs.projectPath) {
        modifiedArgs.projectPath = projectPath;
        console.error(`[代理] 已添加 projectPath 到参数`);
      }
      
      // 转发到服务器
      const result = await forwardToolCallToServer(name, modifiedArgs);
      
      return {
        content: result.content || [{ type: 'text', text: JSON.stringify(result) }],
        isError: result.isError || false
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[代理] 工具调用失败: ${errorMessage}`);
      
      return {
        content: [
          {
            type: 'text',
            text: `错误: ${errorMessage}\n\n请检查:\n1. 服务器是否运行 (node dist/server.js)\n2. WDP_SERVER_URL 是否正确 (${SERVER_URL})\n3. 网络连接是否正常`
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

/**
 * 主函数
 */
async function main() {
  console.error('🔌 WDP MCP 代理客户端启动中...');
  console.error(`📡 远程服务器: ${SERVER_URL}`);
  console.error('💡 提示: 所有业务逻辑都在服务器端，客户端无需更新');
  
  // 初始化本地缓存（同步初始化，避免async问题）
  try {
    const cacheDir = initCache();
    localCacheManager = new LocalCacheManager(cacheDir);
    console.error(`[代理] 本地缓存已初始化: ${cacheDir}`);
  } catch (error) {
    console.error('[代理] 警告: 本地缓存初始化失败:', error.message);
    // 使用临时目录作为回退
    const os = require('os');
    const tempDir = path.join(os.tmpdir(), 'wdp-mcp-cache');
    localCacheManager = new LocalCacheManager(tempDir);
  }
  
  // 启动时预加载工具定义
  try {
    await fetchToolsFromServer();
  } catch (error) {
    console.error('[代理] 警告: 启动时无法连接服务器，将在首次请求时重试');
  }
  
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  
  await server.connect(transport);
  
  console.error('✅ MCP 代理客户端已就绪，等待连接...');
}

main().catch((error) => {
  console.error('致命错误:', error);
  process.exit(1);
});
