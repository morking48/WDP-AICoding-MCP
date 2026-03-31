# 更新日志

## [1.1.0] - 2026-03-31

### 新增功能

#### 1. SQLite 数据库日志系统
- **新增** `src/utils/dbLogger.ts` - SQLite 数据库管理模块
  - 支持 5 种日志表：access_logs, request_logs, skill_logs, error_logs, user_stats
  - 自动创建索引优化查询性能
  - 支持用户时间线查询和统计分析

- **新增** 日志双写机制
  - 文件日志（原有）+ 数据库日志（新增）同时写入
  - 数据库写入失败不影响文件日志
  - 通过 `dbInitialized` 标志控制，确保服务稳定

#### 2. 日志查看工具
- **新增** `scripts/view-logs.ts` - 数据库日志查询脚本
  - `list-users` - 列出所有用户及操作次数
  - `user-timeline <用户名>` - 查看用户操作时间线
  - `user-stats <用户名>` - 查看用户统计信息
  - `recent-access [数量]` - 查看最近访问记录
  - `errors [数量]` - 查看错误记录

#### 3. 日志导出工具
- **新增** `scripts/export-logs.ts` - 数据导出脚本
  - 支持导出为 CSV 格式（Excel 可直接打开）
  - 支持导出为 JSON 格式（完整数据）
  - 支持自定义导出路径（通过 `EXPORT_PATH` 环境变量）
  - 支持按用户导出或导出全部数据

### 改进

#### 1. 日志系统修复
- **修复** `logAccess` 函数未正确传递 `userName` 参数的问题
- **修复** `access` 类型日志未更新用户画像统计的问题
- **修复** `asyncWriteLog` 调用错误导致的崩溃问题

#### 2. 依赖更新
- **新增** `sqlite3` - SQLite 数据库驱动
- **新增** `@types/sqlite3` - TypeScript 类型定义

### 数据库结构

```sql
-- 访问日志表
CREATE TABLE access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  user_name TEXT,
  ip_address TEXT,
  action TEXT,
  user_agent TEXT,
  response_time_ms INTEGER,
  details TEXT
);

-- 请求日志表
CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  user_name TEXT,
  client_ip TEXT,
  raw_input TEXT,
  detected_keywords TEXT,
  routed_skills TEXT,
  confidence REAL
);

-- 技能调用日志表
CREATE TABLE skill_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  user_name TEXT,
  skill_path TEXT,
  tool_name TEXT,
  success BOOLEAN,
  response_time_ms INTEGER,
  content_length INTEGER
);

-- 错误日志表
CREATE TABLE error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  session_id TEXT,
  user_name TEXT,
  error_category TEXT,
  severity TEXT,
  error_message TEXT,
  context TEXT,
  recoverable BOOLEAN,
  user_impact TEXT
);

-- 用户统计表
CREATE TABLE user_stats (
  user_name TEXT PRIMARY KEY,
  total_sessions INTEGER DEFAULT 0,
  total_queries INTEGER DEFAULT 0,
  total_errors INTEGER DEFAULT 0,
  favorite_skills TEXT,
  favorite_tools TEXT,
  last_active DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 使用示例

#### 查看日志
```bash
# 列出所有用户
npx ts-node scripts/view-logs.ts list-users

# 查看用户操作时间线
npx ts-node scripts/view-logs.ts user-timeline 客户A

# 查看用户统计
npx ts-node scripts/view-logs.ts user-stats 客户A
```

#### 导出数据
```bash
# 导出CSV到默认路径
npx ts-node scripts/export-logs.ts export-csv 客户A

# 导出CSV到自定义路径
$env:EXPORT_PATH="D:\analysis\logs"
npx ts-node scripts/export-logs.ts export-csv 客户A

# 导出完整JSON数据
npx ts-node scripts/export-logs.ts export-user 客户A
```

### 文件变更

#### 新增文件
- `src/utils/dbLogger.ts` - SQLite数据库管理模块
- `scripts/view-logs.ts` - 日志查看工具
- `scripts/export-logs.ts` - 日志导出工具
- `CHANGELOG.md` - 更新日志

#### 修改文件
- `src/utils/logger.ts` - 添加数据库双写支持
- `src/server.ts` - 添加数据库初始化
- `package.json` - 添加sqlite3依赖

### 技术细节

- **数据库位置**: `data/logs.db`
- **备份方式**: 直接复制 `data/` 目录
- **兼容性**: 向下兼容，数据库失败不影响文件日志
- **性能**: 异步写入，不影响主流程响应时间
