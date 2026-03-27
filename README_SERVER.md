# WDP 知识引擎 - 服务器管理指南

## 简介

本文档指导管理员如何安装、配置和管理 WDP 知识引擎服务器。

## 环境要求

- Node.js 18+
- Windows / Linux / macOS
- 网络端口 3000（可配置）

## 安装步骤

### 第一步：安装依赖

```bash
cd mcp-knowledge-server
npm install
```

### 第二步：编译项目

```bash
npm run build
```

编译成功后会在 `dist/` 目录生成可执行文件。

## 启动服务器

### 方式一：直接启动（开发测试）

```bash
npm start
```

服务器启动后会显示：
```
[WDP Knowledge Server Started]
HTTP API: http://0.0.0.0:3000
Local: http://localhost:3000
```

### 方式二：使用 PM2 后台运行（生产环境推荐）

```bash
# 安装 PM2（如未安装）
npm install -g pm2

# 启动服务
pm2 start dist/server.js --name wdp-mcp-server

# 保存配置
pm2 save

# 设置开机自启
pm2 startup
```

查看运行状态：
```bash
pm2 status
pm2 logs wdp-mcp-server
```

## Token 管理

### 添加 Token

```bash
# 添加体验用户（public）
npm run token -- add abc123 public 张三

# 添加正式用户（private）
npm run token -- add def456 private 李四
```

### 查看所有 Token

```bash
npm run token -- list
```

显示结果：
```
[Token List]
Total: 2 (Public: 1, Private: 1)
Token        Type    Name    Created
----------------------------------------
abc123...    public  张三    2026/3/27
def456...    private 李四    2026/3/27
```

### 更新 Token 权限

```bash
# 将体验用户升级为正式用户
npm run token -- update abc123 --type private
```

### 禁用/启用 Token

```bash
# 禁用 Token（如用户欠费）
npm run token -- disable abc123 欠费停用

# 启用 Token
npm run token -- enable abc123
```

### 删除 Token

```bash
npm run token -- delete abc123
```

## 环境变量配置

创建 `.env` 文件：

```
PORT=3000                                    # 服务端口
HOST=0.0.0.0                                 # 监听地址
VALID_TOKENS=demo:private:管理员              # 初始Token
ADMIN_TOKEN=your-admin-secret-token          # 管理员Token
KNOWLEDGE_BASE_PATH=../skills                # 知识库路径
```

## API 接口说明

### 公共接口

- `GET /health` - 健康检查

### 需要认证的接口（Bearer Token）

- `GET /api/knowledge?path=xxx` - 获取知识内容
- `POST /api/query` - 查询知识
- `GET /api/skills` - 列出所有技能
- `GET /mcp/tools` - 列出 MCP 工具
- `POST /mcp/call` - 调用 MCP 工具

### 管理接口（需要 X-Admin-Token 请求头）

- `GET /admin/tokens` - 列出所有 Token
- `POST /admin/tokens` - 添加 Token
- `PUT /admin/tokens/:token` - 更新 Token
- `DELETE /admin/tokens/:token` - 删除 Token
- `POST /admin/tokens/:token/disable` - 禁用 Token
- `POST /admin/tokens/:token/enable` - 启用 Token

## 日志管理

日志文件位置：`logs/` 目录

- 访问日志：`logs/access.log`
- 按日期分目录存储

查看日志：
```bash
# 实时查看
pm2 logs

# 查看历史日志
cat logs/access.log
```

## 常见问题

### 端口被占用

```bash
# 查找占用 3000 端口的进程
netstat -ano | findstr :3000

# 结束进程
taskkill /PID <进程ID> /F
```

### Token 验证失败

1. 检查 Token 是否存在：`npm run token -- list`
2. 确认 Token 未被禁用
3. 检查客户端使用的 Token 格式是否正确

### 远程无法访问

1. 确认防火墙允许 3000 端口
2. 检查环境变量 `HOST=0.0.0.0`
3. 测试：`curl http://服务器IP:3000/health`

## 更新服务器

```bash
# 拉取最新代码
git pull

# 重新编译
npm run build

# 重启服务
pm2 restart wdp-mcp-server
```

## 备份与恢复

Token 数据存储在 `config/tokens.json`，建议定期备份。

```bash
# 备份
cp config/tokens.json backup/tokens-$(date +%Y%m%d).json

# 恢复
cp backup/tokens-xxx.json config/tokens.json

# 重启服务
pm2 restart wdp-mcp-server
```
