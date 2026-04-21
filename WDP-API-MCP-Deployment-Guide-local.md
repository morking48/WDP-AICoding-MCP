# WDP MCP 代理客户端 - 局域网版本

## 简介

本指南适用于**局域网环境**下的 MCP 服务部署，方便团队成员在本地测试和开发。

与公网版本的区别：
- 服务器运行在本地/局域网内
- 知识库使用本地文件路径
- 无需网络访问公网服务
- 适合团队协作测试

---

## 快速开始

### 1. 启动本地 MCP 服务器（客户端不需要执行）

在团队共享的服务器或你的电脑上：

```bash
cd D:/WorkFiles_Codex/mcp-knowledge-server

# 安装依赖（首次）
npm install

# 编译 TypeScript
npx tsc

# 启动服务器（监听所有网卡，供局域网访问）
set KNOWLEDGE_BASE_PATH=D:/WorkFiles_Codex/WDP_AIcoding/skills
set PORT=3000
node dist/server.js
```

服务器启动后会显示：
```
🚀 WDP 云端知识引擎已启动
📡 HTTP API: http://0.0.0.0:3000
🌐 本地访问: http://localhost:3000
🔌 远程访问: http://<你的局域网IP>:3000
```

**记录你的局域网 IP**（如 `192.168.1.100`），同事需要用到。

---

### 2. 配置 IDE/AI 助手

#### 2.1 Cline (VS Code 插件)


```json
{
  "mcpServers": {
    "wdp-knowledge-proxy-local": {
      "command": "node",
      "args": [
        "D:/mcp-knowledge-server/remote-client/mcp-proxy-client.js"
      ],
      "env": {
        "WDP_SERVER_URL": "http://10.66.9.105:3000",
        "WDP_KNOWLEDGE_TOKEN": "local-token"
      },
      "disabled": false,
      "autoApprove": [
        "start_wdp_workflow",
        "query_knowledge",
        "get_skill_content",
        "list_skills",
        "check_health",
        "enforce_routing_check",
        "enforce_official_docs_read",
        "enforce_context_memory_check",
        "enforce_object_ids_valid"
      ]
    }
  }
}
```

**环境变量说明**：
- `WDP_SERVER_URL`：MCP服务器地址
- `WDP_KNOWLEDGE_TOKEN`：访问令牌


#### 2.2 Cursor

配置文件路径：
- Windows: `%USERPROFILE%/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "wdp-knowledge-proxy-local": {
      "command": "node",
      "args": [
        "D:/WorkFiles_Codex/mcp-knowledge-server/remote-client/mcp-proxy-client.js"
      ],
      "env": {
        "WDP_SERVER_URL": "http://192.168.1.100:3000",
        "WDP_KNOWLEDGE_TOKEN": "local-token"
      }
    }
  }
}
```

#### 2.3 其他 IDE

配置格式相同，只需修改：
- `WDP_SERVER_URL`: 局域网服务器地址
- `args`: 本地代理客户端路径

---

### 3. 验证连接

配置完成后，在 IDE 的 AI 聊天中测试：

```
调用 check_health，确认 MCP 服务连接正常
```

如果返回服务状态正常，说明配置成功。

---

## 局域网配置要点

### 服务器端配置

| 环境变量 | 说明 | 示例 |
|:---|:---|:---|
| `KNOWLEDGE_BASE_PATH` | 本地知识库路径 | `D:/WorkFiles_Codex/WDP_AIcoding/skills` |
| `PORT` | 服务端口 | `3000` |
| `HOST` | 监听地址 | `0.0.0.0`（允许局域网访问） |

### 客户端配置

| 配置项 | 说明 | 示例 |
|:---|:---|:---|
| `WDP_SERVER_URL` | 局域网服务器地址 | `http://192.168.1.100:3000` |
| `WDP_KNOWLEDGE_TOKEN` | 本地测试令牌 | `local-token`（任意值） |

---

## 团队协作流程

### 场景 A：你作为服务器

1. **启动服务**：在你的电脑上启动 MCP 服务器
2. **分享 IP**：告诉同事你的局域网 IP（如 `192.168.1.100`）
3. **保持运行**：测试期间保持服务器运行

### 场景 B：你作为客户端

1. **获取 IP**：向同事询问服务器 IP
2. **修改配置**：将 `WDP_SERVER_URL` 改为同事的 IP
3. **重启 IDE**：使配置生效

---

## 故障排查

### 问题1：无法连接服务器

**检查**：
```bash
# 在客户端电脑上测试连通性
ping 192.168.1.100

# 测试端口
curl http://192.168.1.100:3000/health
```

**解决**：
- 确认服务器已启动
- 确认防火墙允许 3000 端口
- 确认 IP 地址正确

### 问题2：知识库路径错误

**现象**：工具调用返回 "知识库路径不存在"

**解决**：
```bash
# 在服务器端检查路径
set KNOWLEDGE_BASE_PATH=D:/WorkFiles_Codex/WDP_AIcoding/skills
# 确保路径存在且包含 skills 目录
```

### 问题3：同事无法访问

**检查**：
1. 服务器是否监听 `0.0.0.0`（不是 `localhost`）
2. 防火墙是否放行端口
3. 是否在同一局域网

**Windows 防火墙放行**：
```powershell
# 以管理员身份运行 PowerShell
New-NetFirewallRule -DisplayName "WDP MCP Server" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

---

## 与公网版本对比

| 特性 | 公网版本 | 局域网版本 |
|:---|:---|:---|
| 服务器位置 | code.51aes.com | 本地/团队电脑 |
| 知识库来源 | 服务器同步 | 本地文件 |
| 网络要求 | 需互联网 | 仅需局域网 |
| 适用场景 | 生产使用 | 本地测试、团队协作 |
| Token 管理 | 需申请 | 任意值即可 |

---

## 切换回公网版本

如需切换回公网服务，只需修改 `WDP_SERVER_URL`：

```json
"WDP_SERVER_URL": "http://code.51aes.com"
```

其他配置保持不变。

---

**版本**：WDP API 2.3.0 | BIM API 2.2.0 | GIS API 2.1.0