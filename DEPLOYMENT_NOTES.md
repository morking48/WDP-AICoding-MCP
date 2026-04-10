# WDP MCP 公网版本更新注意事项

**更新日期**：2024-04-10  
**更新内容**：硬编码执行流程 + 缓存机制修复 + 日志系统优化

---

## 📍 架构说明

```
公网服务器（你同事更新）          用户本地机器
├─ 服务端：dist/server.js    ←──── 客户端：remote-client/
├─ 知识库：WDP_AIcoding/           └─ 本地缓存：.wdp-cache/
└─ 日志：logs/
```

- **服务端**：部署在公网，所有用户共享
- **客户端**：部署在用户本地，每个用户独立配置
- **更新范围**：你同事只需更新**服务端**，客户端由用户自行更新（可选）

---

## ⚠️ 关键变更（必须注意）

### 1. 服务端重大变更 ⭐你同事负责

**变更文件**：`src/server.ts`、`src/utils/logger.ts`

**变更内容**：
- `start_wdp_workflow` 改为**硬编码执行**
- 服务器直接读取 skill 和 official 文档，不再依赖 AI 自主调用
- 新增对话日志记录（`conversations.jsonl`、`error-reports.jsonl`）
- 日志写入机制改为"调用次数触发"（每10次）

**影响**：
- ✅ 路由更准确、日志更完整
- ✅ AI 只负责内容组织，不决定路由
- ⚠️ 首次调用可能稍慢（需要读取多个文件）

### 2. 客户端更新 ⭐用户自行决定

**说明**：客户端在**用户本地**，不由你同事部署

**变更文件**：`remote-client/mcp-proxy-client.js`

**变更内容**：
- 修复缓存机制 BUG（之前 `get_skill_content` 从未走缓存）
- 添加 `config/cache-config.json` 到客户端内部

**影响**：
- ⚠️ 不更新客户端 → 缓存不生效，但功能正常
- ✅ 更新客户端 → 缓存生效，减少 Token 消耗

---

## 📋 服务端部署步骤（你同事执行）

### 步骤1：备份（重要）

```bash
# 备份当前服务
cp -r dist dist.backup.$(date +%Y%m%d)
cp -r logs logs.backup.$(date +%Y%m%d)
```

### 步骤2：更新服务端代码

```bash
# 1. 拉取最新代码（或复制新代码）
git pull origin main

# 2. 重新编译
npm run build

# 3. 检查编译是否成功
ls -la dist/
```

### 步骤3：重启服务

```bash
# 1. 停止旧服务
pkill -f "node dist/server.js"

# 2. 启动新服务
npm run start
# 或
node dist/server.js

# 3. 检查服务状态
curl http://localhost:3000/health
```

### 步骤4：验证

```bash
# 检查日志是否正常生成
tail -f logs/$(date +%Y-%m-%d)/conversations.jsonl

# 检查服务响应
curl -X POST http://localhost:3000/mcp/call \
  -H "Authorization: Bearer your-token" \
  -d '{"name":"start_wdp_workflow","arguments":{"user_requirement":"测试","projectPath":"/tmp/test"}}'
```

---

## 📋 客户端更新步骤（用户自行决定）

**注意**：客户端在**用户本地**，不由你同事部署

### 何时需要更新客户端？

| 情况 | 是否需要更新 |
|------|-------------|
| 只使用服务端功能 | ❌ 不需要 |
| 希望缓存生效，减少 Token 消耗 | ✅ 建议更新 |
| 遇到缓存相关 BUG | ✅ 必须更新 |

### 更新步骤

**方式A：直接复制文件夹**
```bash
# 从 GitHub 或你这里获取最新 remote-client 文件夹
# 替换本地的 remote-client 文件夹
```

**方式B：Git 更新**
```bash
git pull origin main
```

**⚠️ 必须确认以下文件已更新**：
- `remote-client/mcp-proxy-client.js`
- `remote-client/config/cache-config.json`

### 客户端验证

```bash
# 调用 start_wdp_workflow，检查 .wdp-cache/ 目录是否有文件生成
# 查看客户端日志是否有 "使用本地缓存" 字样
```

---

## 🔍 常见问题排查

### 问题1：服务启动失败

**症状**：`node dist/server.js` 报错

**排查**：
```bash
# 检查编译是否成功
ls dist/server.js

# 检查依赖是否安装
npm install

# 检查端口是否被占用
lsof -i :3000
```

### 问题2：缓存不生效

**症状**：`.wdp-cache/` 目录为空

**排查**：
1. 确认客户端已更新（`mcp-proxy-client.js` 第 247-254 行有缓存路由判断）
2. 确认 `config/cache-config.json` 存在
3. 检查客户端日志是否有 "使用本地缓存" 字样

### 问题3：日志不生成

**症状**：`logs/` 目录下没有新文件

**排查**：
```bash
# 检查目录权限
ls -la logs/

# 检查磁盘空间
df -h

# 手动创建目录测试
mkdir -p logs/$(date +%Y-%m-%d)
touch logs/$(date +%Y-%m-%d)/test.log
```

### 问题4：硬编码执行太慢

**症状**：`start_wdp_workflow` 响应时间 > 10秒

**原因**：首次调用需要读取多个 skill 文件

**优化**：
- 这是正常现象，后续调用会更快（缓存生效）
- 如需优化，可调整 `src/server.ts` 中读取的文件数量

---

## 📁 文件变更清单

### 服务端（必须更新）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/server.ts` | 重大修改 | 硬编码执行流程 |
| `src/utils/logger.ts` | 重大修改 | 新增对话日志、修改写入机制 |

### 客户端（必须更新）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `remote-client/mcp-proxy-client.js` | 重大修改 | 修复缓存机制 |
| `remote-client/config/cache-config.json` | 新增 | 缓存配置文件 |

### 文档（建议更新）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `remote-client/WDP-API-MCP-User-Manual-optimized.md` | 修改 | 场景4、7输入范式修正 |
| `logs/LOGS_GUIDE.md` | 新增 | 日志说明文档 |

---

## 🔄 回滚方案

如果更新后出现问题，快速回滚：

```bash
# 1. 停止服务
pkill -f "node dist/server.js"

# 2. 恢复备份
rm -rf dist/
cp -r dist.backup.20240410 dist/

# 3. 重启服务
node dist/server.js
```

---

## 📞 更新后验证清单

- [ ] 服务正常启动（`curl /health` 返回 ok）
- [ ] 客户端能正常连接
- [ ] 调用 `start_wdp_workflow` 成功
- [ ] 缓存目录 `.wdp-cache/` 有文件生成
- [ ] 日志文件 `conversations.jsonl` 有记录
- [ ] 场景5输入能触发 `error-reports.jsonl`

---

**更新人员**：__________  
**更新时间**：__________  
**验证人员**：__________
