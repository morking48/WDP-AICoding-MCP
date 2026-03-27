#!/usr/bin/env node
/**
 * WDP MCP Server - 独立版
 * 
 * 这是一个基于 Model Context Protocol (MCP) 的服务器。
 * 它直接通过 stdio 与 AI 工具（如 Cline、Cursor、Claude Desktop）通信，
 * 并直接读取本地知识库文件，无需额外的 HTTP 服务器。
 * 
 * 使用方法:
 * 1. 环境变量配置:
 *    - KNOWLEDGE_BASE_PATH: 知识库路径 (默认: ../../skills)
 * 
 * 2. 在 AI 工具中配置 MCP:
 *    {
 *      "mcpServers": {
 *        "wdp-knowledge": {
 *          "command": "node",
 *          "args": ["/path/to/mcp-knowledge-server/dist/mcp-client.js"],
 *          "env": {
 *            "KNOWLEDGE_BASE_PATH": "/path/to/skills"
 *          }
 *        }
 *      }
 *    }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import fs from 'fs';

// 配置
const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH 
  ? path.resolve(process.env.KNOWLEDGE_BASE_PATH)
  : path.resolve(__dirname, '../../skills');

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
    if (fs.existsSync(KNOWLEDGE_BASE_PATH)) {
      searchDir(KNOWLEDGE_BASE_PATH);
    }
  } catch (error) {
    console.error('搜索失败:', error);
  }
  
  return results;
};

/**
 * 列出所有可用技能
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

/**
 * 创建 MCP Server
 */
function createMCPServer(): Server {
  const server = new Server(
    {
      name: 'wdp-knowledge-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 定义可用工具
  const TOOLS: Tool[] = [
    {
      name: 'query_knowledge',
      description: '查询 WDP 知识库，获取指定技能或路由的文档内容',
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
      description: '获取指定技能文件的完整内容',
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
      description: '列出所有可用的 WDP 技能和文档',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'check_health',
      description: '检查知识引擎的健康状态',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }
  ];

  // 处理工具列表请求
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // 处理工具调用请求
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'query_knowledge': {
          if (!args || typeof args.query !== 'string') {
            throw new Error('缺少 query 参数');
          }
          
          // 如果指定了具体路径，直接返回该文件内容
          if (args.skill_path && typeof args.skill_path === 'string') {
            const content = readKnowledgeFile(args.skill_path);
            if (content) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      type: 'direct',
                      path: args.skill_path,
                      content,
                      timestamp: new Date().toISOString()
                    }, null, 2)
                  }
                ]
              };
            }
          }
          
          // 否则执行搜索
          const results = searchKnowledge(args.query);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  type: 'search',
                  query: args.query,
                  results,
                  resultCount: results.length,
                  timestamp: new Date().toISOString()
                }, null, 2)
              }
            ]
          };
        }

        case 'get_skill_content': {
          if (!args || typeof args.path !== 'string') {
            throw new Error('缺少 path 参数');
          }
          
          const content = readKnowledgeFile(args.path);
          
          if (!content) {
            return {
              content: [
                {
                  type: 'text',
                  text: `错误: 知识文件未找到: ${args.path}`
                }
              ],
              isError: true
            };
          }
          
          return {
            content: [
              {
                type: 'text',
                text: content
              }
            ]
          };
        }

        case 'list_skills': {
          const skills = listAllSkills(KNOWLEDGE_BASE_PATH);
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  skills,
                  timestamp: new Date().toISOString()
                }, null, 2)
              }
            ]
          };
        }

        case 'check_health': {
          const exists = fs.existsSync(KNOWLEDGE_BASE_PATH);
          
          return {
            content: [
              {
                type: 'text',
                text: `服务状态: ${exists ? '正常' : '知识库路径不存在'}\n知识库路径: ${KNOWLEDGE_BASE_PATH}\n时间: ${new Date().toISOString()}`
              }
            ]
          };
        }

        default:
          throw new Error(`未知工具: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `错误: ${errorMessage}`
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
  console.error('🔌 WDP MCP Server 启动中...');
  console.error(`📚 知识库路径: ${KNOWLEDGE_BASE_PATH}`);
  
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  
  await server.connect(transport);
  
  console.error('✅ MCP Server 已就绪，等待连接...');
}

main().catch((error) => {
  console.error('致命错误:', error);
  process.exit(1);
});
