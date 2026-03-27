# WDP 知识引擎（WDP Knowledge Server）

WDP AI Coding 知识引擎 - 通过 HTTP API 和 MCP 协议远程访问 WDP 技能库。

## 文档导航

| 文档 | 适用对象 | 内容说明 |
|------|---------|---------|
| **README_CLIENT.md** | 终端用户 | 客户端配置和使用指南 |
| **README_SERVER.md** | 系统管理员 | 服务器安装、配置和管理 |
| **README_DEPLOY.md** | 运维/开发 | 公网部署、域名和SSL配置 |

## 快速链接

- **我是使用者**：查看 README_CLIENT.md 了解如何连接服务器
- **我是管理员**：查看 README_SERVER.md 了解如何部署和管理
- **需要公网访问**：查看 README_DEPLOY.md 了解生产环境部署

## 核心功能

### 1. 双协议支持
- **HTTP REST API** - 标准REST接口，支持各类客户端调用
- **MCP 协议** - Model Context Protocol，支持AI助手直接集成

### 2. 灵活的权限控制
- **体验用户 (public)**：可使用所有功能，但限制访问技术实现文档
- **正式用户 (private)**：完整访问所有内容
- **禁用状态 (disabled)**：完全禁止访问

### 3. 动态 Token 管理
- 运行时添加、删除、修改 Token
- 实时启用/禁用用户访问
- 权限升级无需重启服务

### 4. 完整的日志系统
- 请求日志 - 记录用户查询内容
- 技能调用日志 - 追踪API使用情况
- 错误日志 - 分类记录各类异常
- 会话统计 - 分析用户使用模式

## 项目结构

```
mcp-knowledge-server/
├── README.md                 # 本文档（入口导航）
├── README_CLIENT.md          # 客户端使用指南
├── README_SERVER.md          # 服务器管理指南
├── README_DEPLOY.md          # 公网部署指南
├── src/
│   ├── server.ts            # 主服务器程序
│   └── utils/
│       ├── tokenManager.ts  # Token 权限管理
│       └── logger.ts        # 日志系统
├── remote-client/           # 客户端程序（分发给用户）
│   ├── mcp-proxy-client.js  # MCP 代理客户端
│   └── package.json
├── scripts/
│   ├── token-admin.ts       # Token 管理脚本
│   └── analytics.ts         # 日志分析脚本
└── config/
    └── tokens.json          # Token 数据存储
```

## 使用流程

### 场景一：局域网内部使用
1. 管理员部署服务器（README_SERVER.md）
2. 管理员创建用户 Token
3. 用户配置 Cline 客户端（README_CLIENT.md）
4. 用户通过 AI 助手访问 WDP 技能

### 场景二：公网远程访问
1. 运维人员部署到云服务器（README_DEPLOY.md）
2. 配置域名和 SSL 证书
3. 管理员创建用户 Token
4. 远程用户通过互联网访问

## 技术支持

如有问题，请根据角色查看对应文档：
- **使用者问题** → README_CLIENT.md 故障排除章节
- **部署问题** → README_SERVER.md 常见问题章节
- **公网配置问题** → README_DEPLOY.md 故障排查章节

## 许可证

MIT License

