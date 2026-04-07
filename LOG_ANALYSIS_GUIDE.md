# WDP 知识引擎 - 日志分析指南

## 📥 日志同步

### 方式1：使用同步脚本（推荐）

双击运行 `scripts/sync-remote-logs.bat`，自动从公网服务器拉取日志到本地。

**拉取位置：**
- 日志文件：`remote-logs/` 目录（按日期分层）
- 数据库：`remote-data/logs.db`（SQLite文件）

### 方式2：手动同步

```bash
# 同步日志文件
scp -r root@code.51aes.com:/opt/wdp-mcp-server/mcp-knowledge-server/logs/* ./remote-logs/

# 同步数据库
scp root@code.51aes.com:/opt/wdp-mcp-server/mcp-knowledge-server/data/logs.db ./remote-data/
```

---

## 📊 日志类型说明

| 日志文件 | 内容说明 | 用途 |
|---------|---------|------|
| `requests.jsonl` | 用户查询请求 | 分析用户查询习惯 |
| `access.jsonl` | API访问记录 | 监控系统访问情况 |
| `skills.jsonl` | 技能调用记录 | 分析热门技能 |
| `errors.jsonl` | 错误日志 | 排查问题 |
| `sessions.jsonl` | 会话结束记录 | 用户行为分析 |

---

## 🔍 日志分析方法

### 方法1：使用 SQLite 数据库（推荐）

#### 安装工具
下载 [DB Browser for SQLite](https://sqlitebrowser.org/dl/)（免费图形化工具）

#### 常用查询

```sql
-- 1. 查看今日活跃用户
SELECT user_name, COUNT(*) as query_count 
FROM request_logs 
WHERE date(timestamp) = date('now')
GROUP BY user_name
ORDER BY query_count DESC;

-- 2. 查看热门技能
SELECT skill_path, COUNT(*) as call_count
FROM skill_logs
GROUP BY skill_path
ORDER BY call_count DESC
LIMIT 10;

-- 3. 查看错误统计
SELECT error_category, severity, COUNT(*) as error_count
FROM error_logs
WHERE date(timestamp) = date('now')
GROUP BY error_category
ORDER BY error_count DESC;

-- 4. 查看用户操作时间线
SELECT 
    timestamp,
    '请求' as type,
    raw_input as content
FROM request_logs 
WHERE user_name = '某用户名'
ORDER BY timestamp DESC
LIMIT 50;

-- 5. 查看平均响应时间
SELECT 
    tool_name,
    AVG(response_time_ms) as avg_time,
    MAX(response_time_ms) as max_time,
    COUNT(*) as call_count
FROM skill_logs
GROUP BY tool_name;
```

### 方法2：使用命令行分析 JSONL 文件

```bash
# 统计今日请求数
cat remote-logs/2025-04-03/requests.jsonl | wc -l

# 查看特定用户的请求
cat remote-logs/2025-04-03/requests.jsonl | grep "某用户名"

# 统计错误数
cat remote-logs/2025-04-03/errors.jsonl | wc -l
```

### 方法3：使用项目自带分析脚本

```bash
# 运行分析脚本
npm run analytics

# 指定数据库路径
npm run analytics -- --db-path=./remote-data/logs.db
```

---

## 📈 关键指标监控

### 每日检查清单

- [ ] 活跃用户数（request_logs 中不同 user_name 数量）
- [ ] 总请求量（request_logs 记录数）
- [ ] 错误率（error_logs 数 / 总请求数）
- [ ] 平均响应时间（skill_logs 中 response_time_ms 平均值）
- [ ] 热门技能TOP5（skill_logs 统计）

### 预警阈值建议

| 指标 | 正常范围 | 预警阈值 |
|------|---------|---------|
| 日活跃用户 | >5人 | <3人 |
| 日请求量 | >100次 | <50次 |
| 错误率 | <5% | >10% |
| 平均响应时间 | <500ms | >2000ms |

---

## 🚀 进阶：自动化报表

### 创建每日报表脚本

创建 `scripts/daily-report.bat`：

```batch
@echo off
echo 正在生成每日报表...

REM 同步日志
call sync-remote-logs.bat

REM 使用 sqlite3 生成报表（需安装 sqlite3 命令行工具）
sqlite3 remote-data/logs.db <<EOF
.mode column
.headers on
.output daily-report.txt

SELECT '=== 每日统计报表 ===' as title;
SELECT datetime('now') as report_time;

SELECT '\n=== 活跃用户TOP10 ===' as section;
SELECT user_name, COUNT(*) as query_count 
FROM request_logs 
WHERE date(timestamp) = date('now')
GROUP BY user_name
ORDER BY query_count DESC
LIMIT 10;

SELECT '\n=== 热门技能TOP5 ===' as section;
SELECT skill_path, COUNT(*) as call_count
FROM skill_logs
WHERE date(timestamp) = date('now')
GROUP BY skill_path
ORDER BY call_count DESC
LIMIT 5;

SELECT '\n=== 错误统计 ===' as section;
SELECT error_category, COUNT(*) as count
FROM error_logs
WHERE date(timestamp) = date('now')
GROUP BY error_category;

.quit
EOF

echo 报表已生成: daily-report.txt
```

---

## ⚠️ 注意事项

1. **同步频率**：建议每天同步一次，避免频繁拉取影响服务器性能
2. **数据安全**：日志文件包含用户查询内容，注意保密
3. **磁盘空间**：定期清理旧日志（保留30天）
4. **数据库锁定**：如果服务器正在写入，SQLite数据库可能无法完整复制

---

## 📞 问题排查

### 同步失败
- 检查SSH连接：`ssh root@code.51aes.com`
- 检查服务器日志目录是否存在
- 确认服务器已启用日志记录

### 数据库打不开
- 可能是文件损坏，尝试重新同步
- 使用 `.recover` 命令修复：`sqlite3 logs.db ".recover" | sqlite3 logs-fixed.db`

### 日志为空
- 检查服务器是否正常运行
- 确认日志目录权限正确
- 查看服务器端日志：`pm2 logs wdp-mcp-server`
