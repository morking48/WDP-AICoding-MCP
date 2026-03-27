# WDP 知识引擎 - 客户端使用指南

## 简介

本文档指导终端用户如何连接和使用 WDP 知识引擎服务器。

## 快速开始

### 第一步：获取客户端文件

向管理员索取 `remote-client.zip` 文件，解压到任意位置，例如：
```
D:\remote-client\
├── mcp-proxy-client.js    （主程序）
├── package.json           （配置）
└── node_modules\         （依赖包）
```

### 第二步：配置 Cline

打开 VS Code 的 Cline 插件设置，添加 MCP 服务器配置：

```json
{
  "mcpServers": {
    "wdp-knowledge-proxy": {
      "command": "node",
      "args": ["D:/remote-client/mcp-proxy-client.js"],
      "env": {
        "WDP_SERVER_URL": "http://服务器IP地址:3000",
        "WDP_KNOWLEDGE_TOKEN": "你的Token"
      },
      "disabled": false,
      "autoApprove": ["start_wdp_workflow", "query_knowledge", "get_skill_content", "list_skills", "check_health"]
    }
  }
}
```

**配置说明：**
- `服务器IP地址`：管理员提供的服务器IP（如 192.168.1.100）
- `你的Token`：管理员分配的访问令牌

### 第三步：了解权限类型

| 类型 | 权限说明 |
|------|---------|
| **体验用户 (public)** | 可使用所有功能，但**不能查看技术文档 (SKILL.md)** |
| **正式用户 (private)** | 可查看所有内容，包括技术实现细节 |

> 提示：体验用户尝试查看 SKILL.md 时会收到升级提示。

### 第四步：测试连接

在 Cline 对话中输入：
```
帮我创建一个3D大楼可视化页面
```

如果配置正确，系统会自动调用 `start_wdp_workflow` 工具启动 WDP 开发工作流。

## 可用工具

- `start_wdp_workflow` - 启动 WDP 开发工作流
- `query_knowledge` - 查询知识库
- `get_skill_content` - 获取指定技能文档
- `list_skills` - 列出所有可用技能
- `check_health` - 检查服务器状态

## 故障排除

### 无法连接服务器

1. 检查服务器IP地址是否正确
2. 确认网络可以访问服务器的 3000 端口
3. 验证 Token 是否有效（联系管理员）

### 提示 "Cannot find module"

- 原因：`node_modules` 文件夹缺失
- 解决：联系管理员重新发送完整的客户端压缩包

### 体验用户无法查看技术文档

- 这是正常权限控制，如需完整访问请联系管理员升级账号

## 联系支持

如有问题，请联系系统管理员获取：
- 服务器地址和端口
- 有效的访问 Token
- 权限升级申请
