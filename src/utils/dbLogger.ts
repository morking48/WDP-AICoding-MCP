/**
 * SQLite 日志数据库管理器
 * 
 * 功能：
 * - 初始化数据库和表结构
 * - 提供日志写入接口
 * - 支持查询统计
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

// 数据库文件路径
const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'logs.db');

// 数据库连接实例
let db: sqlite3.Database | null = null;

/**
 * 初始化数据库
 */
export function initDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    // 确保数据目录存在
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    // 打开数据库连接
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('[DB] 数据库连接失败:', err);
        reject(err);
        return;
      }
      console.log('[DB] 数据库连接成功:', DB_PATH);
      
      // 创建表结构
      createTables()
        .then(() => {
          console.log('[DB] 表结构初始化完成');
          resolve();
        })
        .catch(reject);
    });
  });
}

/**
 * 创建表结构
 */
function createTables(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    const createTableSQL = `
      -- 访问日志表
      CREATE TABLE IF NOT EXISTS access_logs (
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
      CREATE TABLE IF NOT EXISTS request_logs (
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
      CREATE TABLE IF NOT EXISTS skill_logs (
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
      CREATE TABLE IF NOT EXISTS error_logs (
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
      CREATE TABLE IF NOT EXISTS user_stats (
        user_name TEXT PRIMARY KEY,
        total_sessions INTEGER DEFAULT 0,
        total_queries INTEGER DEFAULT 0,
        total_errors INTEGER DEFAULT 0,
        favorite_skills TEXT,
        favorite_tools TEXT,
        last_active DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 创建索引
      CREATE INDEX IF NOT EXISTS idx_access_time ON access_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_access_user ON access_logs(user_name);
      CREATE INDEX IF NOT EXISTS idx_access_session ON access_logs(session_id);
      
      CREATE INDEX IF NOT EXISTS idx_request_time ON request_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_request_user ON request_logs(user_name);
      
      CREATE INDEX IF NOT EXISTS idx_skill_time ON skill_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_skill_user ON skill_logs(user_name);
      
      CREATE INDEX IF NOT EXISTS idx_error_time ON error_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_error_user ON error_logs(user_name);
    `;

    db!.exec(createTableSQL, (err) => {
      if (err) {
        console.error('[DB] 创建表失败:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * 写入访问日志
 */
export function dbLogAccess(data: {
  timestamp: string;
  session_id: string;
  user_name: string;
  ip_address?: string;
  action: string;
  user_agent?: string;
  response_time_ms?: number;
  details?: any;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    const sql = `
      INSERT INTO access_logs 
      (timestamp, session_id, user_name, ip_address, action, user_agent, response_time_ms, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      data.timestamp,
      data.session_id,
      data.user_name,
      data.ip_address || null,
      data.action,
      data.user_agent || null,
      data.response_time_ms || 0,
      data.details ? JSON.stringify(data.details) : null
    ];

    db!.run(sql, params, (err) => {
      if (err) {
        console.error('[DB] 写入access日志失败:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * 写入请求日志
 */
export function dbLogRequest(data: {
  timestamp: string;
  session_id: string;
  user_name: string;
  client_ip: string;
  raw_input: string;
  detected_keywords?: string[];
  routed_skills?: string[];
  confidence?: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    const sql = `
      INSERT INTO request_logs 
      (timestamp, session_id, user_name, client_ip, raw_input, detected_keywords, routed_skills, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      data.timestamp,
      data.session_id,
      data.user_name,
      data.client_ip,
      data.raw_input,
      data.detected_keywords ? JSON.stringify(data.detected_keywords) : null,
      data.routed_skills ? JSON.stringify(data.routed_skills) : null,
      data.confidence || 0
    ];

    db!.run(sql, params, (err) => {
      if (err) {
        console.error('[DB] 写入request日志失败:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * 写入技能调用日志
 */
export function dbLogSkill(data: {
  timestamp: string;
  session_id: string;
  user_name: string;
  skill_path: string;
  tool_name: string;
  success: boolean;
  response_time_ms: number;
  content_length?: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    const sql = `
      INSERT INTO skill_logs 
      (timestamp, session_id, user_name, skill_path, tool_name, success, response_time_ms, content_length)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      data.timestamp,
      data.session_id,
      data.user_name,
      data.skill_path,
      data.tool_name,
      data.success ? 1 : 0,
      data.response_time_ms,
      data.content_length || 0
    ];

    db!.run(sql, params, (err) => {
      if (err) {
        console.error('[DB] 写入skill日志失败:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * 写入错误日志
 */
export function dbLogError(data: {
  timestamp: string;
  session_id: string;
  user_name: string;
  error_category: string;
  severity: string;
  error_message: string;
  context?: any;
  recoverable: boolean;
  user_impact: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    const sql = `
      INSERT INTO error_logs 
      (timestamp, session_id, user_name, error_category, severity, error_message, context, recoverable, user_impact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      data.timestamp,
      data.session_id,
      data.user_name,
      data.error_category,
      data.severity,
      data.error_message,
      data.context ? JSON.stringify(data.context) : null,
      data.recoverable ? 1 : 0,
      data.user_impact
    ];

    db!.run(sql, params, (err) => {
      if (err) {
        console.error('[DB] 写入error日志失败:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * 更新用户统计
 */
export function dbUpdateUserStats(data: {
  user_name: string;
  total_sessions?: number;
  total_queries?: number;
  total_errors?: number;
  favorite_skills?: string[];
  favorite_tools?: string[];
  last_active: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    const sql = `
      INSERT INTO user_stats 
      (user_name, total_sessions, total_queries, total_errors, favorite_skills, favorite_tools, last_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_name) DO UPDATE SET
        total_sessions = COALESCE(?, total_sessions),
        total_queries = COALESCE(?, total_queries),
        total_errors = COALESCE(?, total_errors),
        favorite_skills = COALESCE(?, favorite_skills),
        favorite_tools = COALESCE(?, favorite_tools),
        last_active = ?,
        updated_at = CURRENT_TIMESTAMP
    `;

    const params = [
      data.user_name,
      data.total_sessions || 0,
      data.total_queries || 0,
      data.total_errors || 0,
      data.favorite_skills ? JSON.stringify(data.favorite_skills) : null,
      data.favorite_tools ? JSON.stringify(data.favorite_tools) : null,
      data.last_active,
      // ON CONFLICT UPDATE 参数
      data.total_sessions,
      data.total_queries,
      data.total_errors,
      data.favorite_skills ? JSON.stringify(data.favorite_skills) : null,
      data.favorite_tools ? JSON.stringify(data.favorite_tools) : null,
      data.last_active
    ];

    db!.run(sql, params, (err) => {
      if (err) {
        console.error('[DB] 更新用户统计失败:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * 查询用户操作时间线
 */
export function getUserTimeline(userName: string, date?: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    const dateFilter = date ? `AND date(timestamp) = '${date}'` : '';
    
    const sql = `
      SELECT 
        timestamp,
        'access' as type,
        action as content,
        response_time_ms,
        NULL as error_message
      FROM access_logs 
      WHERE user_name = ? ${dateFilter}
      
      UNION ALL
      
      SELECT 
        timestamp,
        'request' as type,
        raw_input as content,
        NULL as response_time_ms,
        NULL as error_message
      FROM request_logs 
      WHERE user_name = ? ${dateFilter}
      
      UNION ALL
      
      SELECT 
        timestamp,
        'error' as type,
        error_category as content,
        NULL as response_time_ms,
        error_message
      FROM error_logs 
      WHERE user_name = ? ${dateFilter}
      
      ORDER BY timestamp DESC
      LIMIT 100
    `;

    db!.all(sql, [userName, userName, userName], (err, rows) => {
      if (err) {
        console.error('[DB] 查询用户时间线失败:', err);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

/**
 * 获取用户统计
 */
export function getUserStatsFromDB(userName: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    const sql = `SELECT * FROM user_stats WHERE user_name = ?`;
    
    db!.get(sql, [userName], (err, row) => {
      if (err) {
        console.error('[DB] 查询用户统计失败:', err);
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

/**
 * 关闭数据库连接
 */
export function closeDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve();
      return;
    }

    db.close((err) => {
      if (err) {
        console.error('[DB] 关闭数据库失败:', err);
        reject(err);
      } else {
        console.log('[DB] 数据库连接已关闭');
        db = null;
        resolve();
      }
    });
  });
}

// 导出数据库实例（用于高级查询）
export function getDB(): sqlite3.Database | null {
  return db;
}
