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
import {
  MCP_TOOL_DEFINITIONS,
  buildKnowledgeQueryResponse,
  buildWorkflowResponse,
  listKnowledgeEntries,
  readKnowledgeFile,
} from './utils/wdpKnowledge';

// 敏感路径黑名单
const SENSITIVE_PATHS = [
  'wdp-internal-case-acquisition',
  'ONLINE_COVERAGE_AUDIT.md'
];

// 模板文件路径映射（用于快速访问）
const TEMPLATE_FILES = [
  'official_api_code_example/universal-bootstrap.template.html',
  'official_api_code_example/universal-bootstrap.template.main.js',
  'official_api_code_example/universal-bootstrap.template.package.json'
];

/**
 * 检查路径是否为敏感路径
 */
function isSensitivePath(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return SENSITIVE_PATHS.some(sensitive => 
    lowerPath.includes(sensitive.toLowerCase())
  );
}

// 配置
const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH 
  ? path.resolve(process.env.KNOWLEDGE_BASE_PATH)
  : path.resolve(__dirname, '../../WDP_AIcoding/skills');

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
  const TOOLS: Tool[] = MCP_TOOL_DEFINITIONS;

  // 处理工具列表请求
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // 处理工具调用请求
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'start_wdp_workflow': {
          if (!args || typeof args.user_requirement !== 'string') {
            throw new Error('缺少 user_requirement 参数');
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(buildWorkflowResponse(args.user_requirement), null, 2)
              }
            ]
          };
        }

        case 'query_knowledge': {
          if (!args || typeof args.query !== 'string') {
            throw new Error('缺少 query 参数');
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  buildKnowledgeQueryResponse(
                    KNOWLEDGE_BASE_PATH,
                    args.query,
                    typeof args.skill_path === 'string' ? args.skill_path : undefined,
                  ),
                  null,
                  2,
                )
              }
            ]
          };
        }

        case 'get_skill_content': {
          if (!args || typeof args.path !== 'string') {
            throw new Error('缺少 path 参数');
          }
          
          // 检查是否为敏感路径
          if (isSensitivePath(args.path)) {
            return {
              content: [
                {
                  type: 'text',
                  text: '错误: 无权访问该资源'
                }
              ],
              isError: true
            };
          }
          
          const content = readKnowledgeFile(KNOWLEDGE_BASE_PATH, args.path);
          
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
          const skills = listKnowledgeEntries(KNOWLEDGE_BASE_PATH, {
            includeReferences: Boolean(args?.include_references),
          });
          
          // 确保模板文件被包含在列表中
          const templateFiles = TEMPLATE_FILES.map(templatePath => ({
            name: path.basename(templatePath),
            path: templatePath,
            type: 'template',
            isTemplate: true
          }));
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  skills,
                  includeReferences: Boolean(args?.include_references),
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
