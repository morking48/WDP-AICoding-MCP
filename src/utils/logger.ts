/**
 * 用户分层日志管理器（方案A）
 * 
 * 特点：
 * - 按日期 + 用户分层存储
 * - 每个用户独立目录，便于分析习惯
 * - 保留总览日志（all-users.log）
 * - 自动生成用户画像和统计
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  initDatabase,
  dbLogAccess,
  dbLogRequest,
  dbLogSkill,
  dbLogError,
  dbUpdateUserStats
} from './dbLogger';

// 日志根目录
const LOGS_ROOT = path.resolve(__dirname, '../../logs');

// 数据库初始化标志
let dbInitialized = false;

/**
 * 初始化日志系统（包括数据库）
 */
export async function initLogger(): Promise<void> {
  try {
    await initDatabase();
    dbInitialized = true;
    console.log('[Logger] 数据库日志系统初始化成功');
  } catch (error) {
    console.error('[Logger] 数据库初始化失败，将仅使用文件日志:', error);
    dbInitialized = false;
  }
}

// 内存队列（批量写入）
const logQueues: { [key: string]: string[] } = {};
const flushTimers: { [key: string]: NodeJS.Timeout | null } = {};
const queueSizes: { [key: string]: number } = {}; // 记录每个队列的字节大小

// 写入配置
const FLUSH_CONFIG = {
  maxLines: 50,           // 最多缓存50行
  maxBytes: 1024 * 1024, // 最多缓存1MB
  maxDelayMs: 5000,      // 最多延迟5秒
  profileSaveInterval: 5 * 60 * 1000 // 每5分钟保存用户画像
};

// 用户画像缓存（内存中维护，定期写入文件）
const userProfiles: Map<string, UserProfile> = new Map();
let profileSaveTimer: NodeJS.Timeout | null = null;

// 会话管理
const sessionMap = new Map<string, SessionInfo>();

interface SessionInfo {
  startTime: Date;
  userName: string;
  skills: Set<string>;
  queries: string[];
  errors: number;
  tools: Map<string, number>; // 工具调用次数统计
}

interface UserProfile {
  userName: string;
  totalSessions: number;
  totalQueries: number;
  totalErrors: number;
  favoriteSkills: string[];
  favoriteTools: string[];
  lastActive: string;
  dailyStats: { [date: string]: DailyStat };
}

interface DailyStat {
  queries: number;
  errors: number;
  skills: Set<string>;
  tools: Map<string, number>;
}

/**
 * 获取今天的日志目录
 */
function getTodayLogDir(): string {
  const today = new Date().toISOString().split('T')[0];
  const dir = path.join(LOGS_ROOT, today);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取用户的日志目录
 */
function getUserLogDir(userName: string): string {
  const todayDir = getTodayLogDir();
  const userDir = path.join(todayDir, userName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_'));
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

/**
 * 异步批量写入日志
 * 
 * @param logType 日志类型
 * @param data 日志数据
 * @param userName 用户名（用于按用户分层）
 */
function asyncWriteLog(logType: string, data: any, userName?: string): void {
  const todayDir = getTodayLogDir();
  const today = new Date().toISOString().split('T')[0];
  
  // 1. 写入总览日志（all-users.log）
  const allUsersLogFile = path.join(todayDir, `${logType}.jsonl`);
  queueLogWrite(`${logType}:all`, allUsersLogFile, data);
  
  // 2. 写入用户专属日志（如果提供了用户名）
  if (userName && userName !== 'anonymous') {
    const userDir = getUserLogDir(userName);
    const userLogFile = path.join(userDir, `${logType}.jsonl`);
    queueLogWrite(`${logType}:${userName}`, userLogFile, data);
    
    // 3. 更新用户画像
    updateUserProfile(userName, data, today);
  }
}

/**
 * 将日志加入写入队列
 */
function queueLogWrite(queueKey: string, logFile: string, data: any): void {
  const logLine = JSON.stringify(data);
  const lineBytes = Buffer.byteLength(logLine, 'utf8');
  
  if (!logQueues[queueKey]) {
    logQueues[queueKey] = [];
    queueSizes[queueKey] = 0;
  }
  
  logQueues[queueKey].push(logLine);
  queueSizes[queueKey] += lineBytes;
  
  // 检查是否需要立即写入（行数或大小超限）
  const shouldFlushNow = 
    logQueues[queueKey].length >= FLUSH_CONFIG.maxLines ||
    queueSizes[queueKey] >= FLUSH_CONFIG.maxBytes;
  
  if (shouldFlushNow) {
    // 立即写入，取消定时器
    if (flushTimers[queueKey]) {
      clearTimeout(flushTimers[queueKey]);
      flushTimers[queueKey] = null;
    }
    flushLogQueue(queueKey, logFile);
  } else if (!flushTimers[queueKey]) {
    // 设置定时器，确保数据不会延迟太久
    flushTimers[queueKey] = setTimeout(() => {
      flushLogQueue(queueKey, logFile);
    }, FLUSH_CONFIG.maxDelayMs);
  }
}

/**
 * 刷新日志队列到文件
 */
function flushLogQueue(queueKey: string, logFile: string): void {
  if (!logQueues[queueKey] || logQueues[queueKey].length === 0) {
    return;
  }
  
  const lines = logQueues[queueKey].join('\n') + '\n';
  const lineCount = logQueues[queueKey].length;
  const bytesWritten = queueSizes[queueKey] || 0;
  
  // 清空队列
  logQueues[queueKey] = [];
  queueSizes[queueKey] = 0;
  flushTimers[queueKey] = null;
  
  try {
    fs.appendFileSync(logFile, lines);
    
    // 调试信息（超过50条时显示）
    if (lineCount >= 50) {
      console.log(`[Logger] 批量写入 ${lineCount} 条日志 (${(bytesWritten / 1024).toFixed(1)}KB) → ${path.basename(logFile)}`);
    }
  } catch (error) {
    console.error(`[Logger] 写入日志失败: ${error}`);
  }
}

/**
 * 启动定期保存用户画像的定时器
 */
function startProfileSaveTimer(): void {
  if (profileSaveTimer) {
    clearInterval(profileSaveTimer);
  }
  
  profileSaveTimer = setInterval(() => {
    saveUserProfiles();
    console.log(`[Logger] 自动保存用户画像，当前活跃用户: ${userProfiles.size} 人`);
  }, FLUSH_CONFIG.profileSaveInterval);
}

/**
 * 更新用户画像
 */
function updateUserProfile(userName: string, data: any, date: string): void {
  if (!userProfiles.has(userName)) {
    userProfiles.set(userName, {
      userName,
      totalSessions: 0,
      totalQueries: 0,
      totalErrors: 0,
      favoriteSkills: [],
      favoriteTools: [],
      lastActive: date,
      dailyStats: {}
    });
  }
  
  const profile = userProfiles.get(userName)!;
  
  // 初始化当日统计
  if (!profile.dailyStats[date]) {
    profile.dailyStats[date] = {
      queries: 0,
      errors: 0,
      skills: new Set(),
      tools: new Map()
    };
  }
  
  const todayStat = profile.dailyStats[date];
  
  // 根据日志类型更新统计
  switch (data.type) {
    case 'request':
      profile.totalQueries++;
      todayStat.queries++;
      break;
      
    case 'skill_invocation':
      if (data.skill_path) {
        todayStat.skills.add(data.skill_path);
      }
      if (data.tool_name) {
        const count = todayStat.tools.get(data.tool_name) || 0;
        todayStat.tools.set(data.tool_name, count + 1);
      }
      break;
      
    case 'error':
      profile.totalErrors++;
      todayStat.errors++;
      break;
      
    case 'session_end':
      profile.totalSessions++;
      break;
      
    case 'access':
      // access 类型日志也统计为一次查询/访问
      profile.totalQueries++;
      todayStat.queries++;
      // 如果有 action 信息，记录到 tools 中用于分析用户行为
      if (data.action) {
        const actionKey = `action:${data.action}`;
        const count = todayStat.tools.get(actionKey) || 0;
        todayStat.tools.set(actionKey, count + 1);
      }
      break;
  }
  
  profile.lastActive = date;
}

/**
 * 保存用户画像到文件
 */
function saveUserProfiles(): void {
  const todayDir = getTodayLogDir();
  const analyticsDir = path.join(LOGS_ROOT, 'analytics');
  if (!fs.existsSync(analyticsDir)) {
    fs.mkdirSync(analyticsDir, { recursive: true });
  }
  
  userProfiles.forEach((profile, userName) => {
    // 计算最喜欢的技能和工具
    const skillCounts: { [skill: string]: number } = {};
    const toolCounts: { [tool: string]: number } = {};
    
    Object.values(profile.dailyStats).forEach(stat => {
      stat.skills.forEach(skill => {
        skillCounts[skill] = (skillCounts[skill] || 0) + 1;
      });
      stat.tools.forEach((count, tool) => {
        toolCounts[tool] = (toolCounts[tool] || 0) + count;
      });
    });
    
    profile.favoriteSkills = Object.entries(skillCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([skill]) => skill);
    
    profile.favoriteTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool]) => tool);
    
    // 保存用户画像
    const profileFile = path.join(analyticsDir, `${userName}-profile.json`);
    
    // 转换 Map 和 Set 为普通对象以便 JSON 序列化
    const serializedProfile = {
      ...profile,
      dailyStats: Object.fromEntries(
        Object.entries(profile.dailyStats).map(([date, stat]) => [
          date,
          {
            ...stat,
            skills: Array.from(stat.skills),
            tools: Object.fromEntries(stat.tools)
          }
        ])
      )
    };
    
    try {
      fs.writeFileSync(profileFile, JSON.stringify(serializedProfile, null, 2));
    } catch (error) {
      console.error(`[Logger] 保存用户画像失败: ${error}`);
    }
  });
}

/**
 * 生成或获取会话ID
 */
export function getOrCreateSessionId(clientIp: string, userName: string = 'anonymous'): string {
  const sessionId = uuidv4();
  
  sessionMap.set(sessionId, {
    startTime: new Date(),
    userName,
    skills: new Set(),
    queries: [],
    errors: 0,
    tools: new Map()
  });
  
  return sessionId;
}

/**
 * 记录用户请求日志
 */
export function logRequest(data: {
  sessionId: string;
  clientIp: string;
  rawInput: string;
  userName?: string;
  detectedKeywords?: string[];
  routedSkills?: string[];
  confidence?: number;
}): void {
  const session = sessionMap.get(data.sessionId);
  const userName = data.userName || session?.userName || 'anonymous';
  
  if (session) {
    session.queries.push(data.rawInput);
  }
  
  const logData = {
    timestamp: new Date().toISOString(),
    type: 'request',
    session_id: data.sessionId,
    client_ip: data.clientIp,
    raw_input: data.rawInput,
    intent_analysis: {
      detected_keywords: data.detectedKeywords || [],
      routed_skills: data.routedSkills || [],
      confidence: data.confidence || 0
    }
  };
  
  // 写入文件日志
  asyncWriteLog('requests', logData, userName);
  
  // 写入数据库（双写）
  if (dbInitialized) {
    dbLogRequest({
      timestamp: logData.timestamp,
      session_id: data.sessionId,
      user_name: userName,
      client_ip: data.clientIp,
      raw_input: data.rawInput,
      detected_keywords: data.detectedKeywords,
      routed_skills: data.routedSkills,
      confidence: data.confidence
    }).catch(err => {
      // 数据库写入失败不影响文件日志
      console.error('[Logger] 数据库写入失败:', err);
    });
  }
}

/**
 * 记录Skill调用日志
 */
export function logSkillInvocation(data: {
  sessionId: string;
  skillPath: string;
  toolName: string;
  success: boolean;
  responseTimeMs: number;
  contentLength?: number;
}): void {
  const session = sessionMap.get(data.sessionId);
  const userName = session?.userName || 'anonymous';
  
  if (session) {
    session.skills.add(data.skillPath);
    const toolCount = session.tools.get(data.toolName) || 0;
    session.tools.set(data.toolName, toolCount + 1);
  }
  
  const logData = {
    timestamp: new Date().toISOString(),
    type: 'skill_invocation',
    session_id: data.sessionId,
    skill_path: data.skillPath,
    tool_name: data.toolName,
    success: data.success,
    response_time_ms: data.responseTimeMs,
    content_length: data.contentLength || 0
  };
  
  // 写入文件日志
  asyncWriteLog('skills', logData, userName);
  
  // 写入数据库（双写）
  if (dbInitialized) {
    dbLogSkill({
      timestamp: logData.timestamp,
      session_id: data.sessionId,
      user_name: userName,
      skill_path: data.skillPath,
      tool_name: data.toolName,
      success: data.success,
      response_time_ms: data.responseTimeMs,
      content_length: data.contentLength
    }).catch(err => {
      console.error('[Logger] 数据库写入失败:', err);
    });
  }
}

/**
 * 记录工作流步骤
 */
export function logWorkflowStep(data: {
  sessionId: string;
  step: number;
  action: string;
  skill?: string | null;
}): void {
  const session = sessionMap.get(data.sessionId);
  const userName = session?.userName || 'anonymous';
  
  asyncWriteLog('workflows', {
    timestamp: new Date().toISOString(),
    type: 'workflow_step',
    session_id: data.sessionId,
    step: data.step,
    action: data.action,
    skill: data.skill || null
  }, userName);
}

/**
 * 记录错误日志
 */
export function logError(data: {
  sessionId: string;
  errorCategory: string;
  severity: 'high' | 'medium' | 'low';
  errorMessage: string;
  userName?: string;
  context: {
    userInput?: string;
    routedSkill?: string;
    suggestedSkills?: string[];
    workflowStep?: number;
    userName?: string;
  };
  recoverable: boolean;
  userImpact: string;
}): void {
  const session = sessionMap.get(data.sessionId);
  const userName = data.userName || data.context.userName || session?.userName || 'anonymous';
  
  if (session) {
    session.errors++;
  }
  
  const logData = {
    timestamp: new Date().toISOString(),
    type: 'error',
    session_id: data.sessionId,
    error_category: data.errorCategory,
    severity: data.severity,
    error_message: data.errorMessage,
    context: data.context,
    recoverable: data.recoverable,
    user_impact: data.userImpact
  };
  
  // 写入文件日志
  asyncWriteLog('errors', logData, userName);
  
  // 写入数据库（双写）
  if (dbInitialized) {
    dbLogError({
      timestamp: logData.timestamp,
      session_id: data.sessionId,
      user_name: userName,
      error_category: data.errorCategory,
      severity: data.severity,
      error_message: data.errorMessage,
      context: data.context,
      recoverable: data.recoverable,
      user_impact: data.userImpact
    }).catch(err => {
      console.error('[Logger] 数据库写入失败:', err);
    });
  }
}

/**
 * 记录访问日志（server.ts 中使用）
 */
export function logAccess(data: {
  sessionId: string;
  ip?: string;
  action: string;
  userName?: string;
  userAgent?: string;
  responseTimeMs?: number;
  [key: string]: any;
}): void {
  const userName = data.userName || 'anonymous';
  
  const logData = {
    timestamp: new Date().toISOString(),
    type: 'access',
    ...data
  };
  
  // 写入文件日志
  asyncWriteLog('access', logData, userName);
  
  // 写入数据库（双写）
  if (dbInitialized) {
    dbLogAccess({
      timestamp: logData.timestamp,
      session_id: data.sessionId,
      user_name: userName,
      ip_address: data.ip,
      action: data.action,
      user_agent: data.userAgent,
      response_time_ms: data.responseTimeMs,
      details: data
    }).catch(err => {
      console.error('[Logger] 数据库写入失败:', err);
    });
  }
}

/**
 * 记录会话结束
 */
export function logSessionEnd(sessionId: string, status: 'completed' | 'partial' | 'error'): void {
  const session = sessionMap.get(sessionId);
  if (!session) return;
  
  const endTime = new Date();
  const durationMs = endTime.getTime() - session.startTime.getTime();
  const userName = session.userName;
  
  asyncWriteLog('sessions', {
    timestamp: endTime.toISOString(),
    type: 'session_end',
    session_id: sessionId,
    user_name: userName,
    start_time: session.startTime.toISOString(),
    end_time: endTime.toISOString(),
    duration_ms: durationMs,
    skills_used: Array.from(session.skills),
    tools_used: Object.fromEntries(session.tools),
    queries_count: session.queries.length,
    error_count: session.errors,
    completion_status: status
  }, userName);
  
  // 保存用户画像
  saveUserProfiles();
  
  // 清理会话数据
  sessionMap.delete(sessionId);
}

/**
 * 强制刷新所有日志（程序退出前调用）
 */
export function flushAllLogs(): void {
  const todayDir = getTodayLogDir();
  
  // 刷新所有队列
  Object.keys(logQueues).forEach(queueKey => {
    const [logType, userName] = queueKey.split(':');
    if (userName && userName !== 'all') {
      const userDir = getUserLogDir(userName);
      const logFile = path.join(userDir, `${logType}.jsonl`);
      flushLogQueue(queueKey, logFile);
    } else {
      const logFile = path.join(todayDir, `${logType}.jsonl`);
      flushLogQueue(queueKey, logFile);
    }
  });
  
  // 保存用户画像
  saveUserProfiles();
}

/**
 * 清理旧日志（保留最近N天）
 */
export function cleanupOldLogs(keepDays: number = 30): void {
  if (!fs.existsSync(LOGS_ROOT)) return;
  
  const dirs = fs.readdirSync(LOGS_ROOT);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - keepDays);
  
  dirs.forEach(dir => {
    const dirPath = path.join(LOGS_ROOT, dir);
    const stat = fs.statSync(dirPath);
    
    // 跳过 analytics 目录
    if (dir === 'analytics') return;
    
    if (stat.isDirectory()) {
      const dirDate = new Date(dir);
      if (dirDate < cutoffDate) {
        try {
          fs.rmSync(dirPath, { recursive: true });
          console.log(`[Logger] 清理旧日志: ${dir}`);
        } catch (error) {
          console.error(`[Logger] 清理日志失败: ${dir}`, error);
        }
      }
    }
  });
}

/**
 * 获取用户统计信息
 */
export function getUserStats(userName: string): UserProfile | null {
  return userProfiles.get(userName) || null;
}

/**
 * 获取所有活跃用户列表
 */
export function getActiveUsers(): string[] {
  return Array.from(userProfiles.keys());
}

/**
 * 获取当前队列状态（用于监控）
 */
export function getQueueStatus(): { [key: string]: { lines: number; bytes: number } } {
  const status: { [key: string]: { lines: number; bytes: number } } = {};
  
  Object.keys(logQueues).forEach(key => {
    status[key] = {
      lines: logQueues[key]?.length || 0,
      bytes: queueSizes[key] || 0
    };
  });
  
  return status;
}

/**
 * 手动触发所有队列写入（用于监控或优雅关闭）
 */
export function flushAllQueues(): void {
  const todayDir = getTodayLogDir();
  
  Object.keys(logQueues).forEach(queueKey => {
    const [logType, userName] = queueKey.split(':');
    if (userName && userName !== 'all') {
      const userDir = getUserLogDir(userName);
      const logFile = path.join(userDir, `${logType}.jsonl`);
      flushLogQueue(queueKey, logFile);
    } else {
      const logFile = path.join(todayDir, `${logType}.jsonl`);
      flushLogQueue(queueKey, logFile);
    }
  });
  
  console.log('[Logger] 所有日志队列已刷新');
}

// 启动定期保存
startProfileSaveTimer();

// 程序退出前刷新日志
process.on('exit', flushAllLogs);
process.on('SIGINT', () => {
  flushAllLogs();
  if (profileSaveTimer) {
    clearInterval(profileSaveTimer);
  }
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushAllLogs();
  if (profileSaveTimer) {
    clearInterval(profileSaveTimer);
  }
  process.exit(0);
});
