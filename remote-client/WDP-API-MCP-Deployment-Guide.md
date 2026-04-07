# WDP MCP 代理客户端 - 零更新方案

## 简介

这是**智能代理模式**的客户端，只负责桥接 IDE/AI 助手和远程服务器。

**核心优势**：
- ✅ **客户端永不更新** - 所有业务逻辑在服务器端
- ✅ **极简代码** - 仅 80 行，几乎不需要维护
- ✅ **自动同步** - 服务器更新后，客户端自动获取最新功能
- ✅ **缓存优化** - 工具定义缓存 60 秒，减少网络请求

---

## 文件说明

- `mcp-proxy-client.js` - 代理客户端（80行，永不更新）
- `package.json` - 依赖配置
- `PROXY_README.md` - 本文档

---

## 快速开始

### 1. 解压压缩包

将 `wdp-mcp-proxy.zip` 解压到任意位置，例如：
```
C:\Users\用户名\Documents\wdp-mcp-proxy\
```

### 2. 在 IDE 中配置 MCP

#### 2.1 Cline (VS Code 插件)

配置文件路径：
- Windows: `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "wdp-knowledge-proxy": {
      "command": "node",
      "args": [
        "X:/XXXXX/remote-client/mcp-proxy-client.js"
      ],
      "env": {
        "WDP_SERVER_URL": "http://code.51aes.com",
        "WDP_KNOWLEDGE_TOKEN": "相关管理员申请"
      },
      "disabled": false,
      "autoApprove": [
        "start_wdp_workflow",
        "query_knowledge",
        "get_skill_content",
        "list_skills",
        "check_health"
      ]
    }
  }
}
```

#### 2.2 Cursor

配置文件路径：
- Windows: `%USERPROFILE%/.cursor/mcp.json`
- macOS: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "wdp-knowledge-proxy": {
      "command": "node",
      "args": [
        "X:/XXXXX/remote-client/mcp-proxy-client.js"
      ],
      "env": {
        "WDP_SERVER_URL": "http://code.51aes.com",
        "WDP_KNOWLEDGE_TOKEN": "H7xR9wK2mN5qP8vT4zB1uY6jC3sD9gF0"
      }
    }
  }
}
```

配置步骤：
1. 打开 Cursor → Settings → MCP
2. 点击 "Add new MCP server"
3. 选择 "Command" 类型
4. 填写配置信息

#### 2.3 Windsurf

配置文件路径：
- Windows: `%USERPROFILE%/.windsurf/mcp_config.json`
- macOS: `~/.windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "wdp-knowledge-proxy": {
      "command": "node",
      "args": [
        "X:/XXXXX/remote-client/mcp-proxy-client.js"
      ],
      "env": {
        "WDP_SERVER_URL": "http://code.51aes.com",
        "WDP_KNOWLEDGE_TOKEN": "H7xR9wK2mN5qP8vT4zB1uY6jC3sD9gF0"
      }
    }
  }
}
```

配置步骤：
1. 打开 Windsurf → Settings → AI Settings
2. 找到 "MCP Servers" 部分
3. 添加新的 MCP 服务器配置

#### 2.4 Claude Desktop

配置文件路径：
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "wdp-knowledge-proxy": {
      "command": "node",
      "args": [
        "X:/XXXXX/remote-client/mcp-proxy-client.js"
      ],
      "env": {
        "WDP_SERVER_URL": "http://code.51aes.com",
        "WDP_KNOWLEDGE_TOKEN": "H7xR9wK2mN5qP8vT4zB1uY6jC3sD9gF0"
      }
    }
  }
}
```

配置步骤：
1. 打开 Claude Desktop
2. 点击菜单栏 → Settings → Developer
3. 点击 "Edit Config" 编辑配置文件
4. 添加 MCP 服务器配置
5. 重启 Claude Desktop

#### 2.5 其他支持 MCP 的 IDE

对于其他支持 MCP 的 IDE（如 Zed、GitHub Copilot Chat 等），配置格式基本相同：

```json
{
  "mcpServers": {
    "wdp-knowledge-proxy": {
      "command": "node",
      "args": [
        "/path/to/mcp-proxy-client.js"
      ],
      "env": {
        "WDP_SERVER_URL": "http://code.51aes.com",
        "WDP_KNOWLEDGE_TOKEN": "你的用户Token"
      }
    }
  }
}
```

⚠️ **配置注意事项**：
- 将路径改为 `mcp-proxy-client.js` 的实际绝对路径
- 将 `WDP_KNOWLEDGE_TOKEN` 替换为管理员分配给你的用户 Token
- Windows 路径使用正斜杠 `/` 或双反斜杠 `\\`
- 确保 Node.js 已安装且可在命令行中运行

### 3. 验证连接

配置完成后，在 IDE 的 AI 聊天中测试：

```
帮我访问下WDP相关技能库内容有什么
```

AI 会自动调用 `start_wdp_workflow` 工具，获取工作流指导。

如果看到 AI 开始询问需求细节或输出执行路径，说明 MCP 连接成功。

---

## 工作原理

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  IDE/AI助手  │────▶│  代理客户端      │────▶│   你的服务器     │
│  (用户界面)  │     │  (仅桥接)       │     │  (业务逻辑)      │
└─────────────┘     └─────────────────┘     └─────────────────┘
                           │                         │
                           │  1. 获取工具定义         │
                           │  GET /mcp/tools         │
                           │  (缓存60秒)             │
                           │                         │
                           │  2. 转发工具调用         │
                           │  POST /mcp/call         │
                           │                         │
```

**代理客户端职责**：
1. 从服务器获取工具定义（缓存60秒）
2. 将 IDE/AI 助手的工具调用转发到服务器
3. 返回服务器的结果给 IDE/AI 助手

**服务器职责**：
- 所有业务逻辑
- 工具定义管理
- 知识库查询
- 工作流编排

---

## 与旧版客户端对比

| 特性 | 旧版客户端 | 代理客户端（新版） |
|------|-----------|------------------|
| 代码行数 | ~300行 | ~80行 |
| 业务逻辑 | 客户端 | 服务器端 |
| 更新频率 | 每次功能更新 | 几乎永不更新 |
| 工具定义 | 硬编码 | 动态获取 |
| 缓存机制 | 无 | 60秒缓存 |

---

## 服务器端点

代理客户端会访问服务器的以下端点：

### GET /mcp/tools
获取工具定义列表

**响应**：
```json
{
  "tools": [
    {
      "name": "start_wdp_workflow",
      "description": "...",
      "inputSchema": { ... }
    }
  ]
}
```

### POST /mcp/call
调用指定工具

**请求**：
```json
{
  "name": "query_knowledge",
  "arguments": {
    "query": "camera"
  }
}
```

**响应**：
```json
{
  "content": [
    { "type": "text", "text": "..." }
  ],
  "isError": false
}
```

---

## 故障排查

### 问题1：显示 "获取工具定义失败"

**原因**：无法连接服务器

**解决**：
1. 确认服务器已启动：`node dist/server.js`
2. 检查 `WDP_SERVER_URL` 是否正确
3. 检查网络连接：`ping 10.66.9.105`

### 问题2：工具调用返回错误

**原因**：服务器端处理失败

**解决**：
1. 查看服务器日志：`logs/access.log`
2. 确认知识库路径正确
3. 检查 Token 是否有效

### 问题3：工具列表不更新

**原因**：客户端缓存了旧数据

**解决**：
- 等待 60 秒缓存过期
- 或重启 IDE/AI 助手

---

## 更新历史

### v1.1.0 (2026-04-03)
- 扩展多 IDE 支持文档
- 新增 Cursor、Windsurf、Claude Desktop 配置指南
- 更新描述，从仅支持 Cline 扩展到通用 IDE/AI 助手
- 添加各 IDE 的配置文件路径和配置步骤

### v1.0.0 (2026-03-26)
- 初始版本
- 实现智能代理模式
- 支持工具定义动态获取
- 60秒缓存机制

---

## 未来扩展

当部署到公网时，可以：
1. 在服务器端添加用户认证
2. 实现 HTTPS 加密传输
3. 添加访问权限控制
4. 迁移到 SSE 远程 MCP 模式

代理客户端无需任何修改！
