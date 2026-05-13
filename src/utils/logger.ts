/**
 * 用户分层日志管理器
 *
 * 特点：
 * - 按日期 + 用户分层存储
 * - 每个用户独立目录，便于分析习惯
 * - 保留总览日志
 * - 自动生成用户画像和统计
 * - 批量队列写入（减少 I/O）
 * - 场景识别 + 对话日志
 *
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import pinyin from 'pinyin';
import {
  initDatabase,
  dbLogAccess,
  dbLogRequest,
  dbLogSkill,
  dbLogError,
} from './dbLogger';

// 日志根目录
const LOGS_ROOT = path.resolve(__dirname, '../../logs');

// 数据库初始化标志
let dbInitialized = false;

// 内存队列（批量写入）
const logQueues: { [key: string]: string[] } = {};
const flushTimers: { [key: string]: NodeJS.Timeout | null } = {};
const queueSizes: { [key: string]: number } = {};

// 写入配置
const FLUSH_CONFIG = {
  maxLines: 100,
  maxBytes: 2 * 1024 * 1024,
  maxDelayMs: 60000,
  profileSaveInterval: 5 * 60 * 1000,
  callCountTrigger: 10,
};

const callCounters: { [key: string]: number } = {};

// 用户画像缓存
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
  tools: Map<string, number>;
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

// ========== 目录工具 ==========

function getTodayLogDir(): string {
  const today = new Date().toISOString().split('T')[0];
  const dir = path.join(LOGS_ROOT, today);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getUserLogDir(userName: string): string {
  const todayDir = getTodayLogDir();
  const dirName = convertUserNameToDirName(userName);
  const userDir = path.join(todayDir, dirName);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

/**
 * 中文转拼音 - 使用 pinyin 库
 * 全量转换，不含中文，避免乱码
 */
function chineseToPinyin(chinese: string): string {
  try {
    const result = pinyin(chinese, {
      style: pinyin.STYLE_NORMAL,
      heteronym: false,
    });
    const pinyinStr = result.map((item: string[]) => item[0]).join('');
    return pinyinStr.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'unknown';
  } catch (error) {
    console.error('[Logger] 拼音转换失败:', error);
    let result = '';
    for (let i = 0; i < chinese.length; i++) {
      const char = chinese[i];
      const code = chinese.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) {
        result += 'u' + code.toString(16).toLowerCase();
      } else if (/[a-zA-Z0-9]/.test(char)) {
        result += char.toLowerCase();
      }
    }
    return result || 'unknown';
  }
}

/**
 * 将用户名转换为拼音格式的目录名
 * 格式：部门代码_姓名拼音
 * 例如：内部员工（tb）-蒋丽 → tb_jiangli
 */
function convertUserNameToDirName(userName: string): string {
  let deptCode = '';
  const deptMatch = userName.match(/[（(](wdp|tb|bd|工程)[）)]/i);
  if (deptMatch) {
    deptCode = deptMatch[1].toLowerCase();
  } else if (userName.startsWith('客户')) {
    deptCode = 'kehu';
  } else {
    deptCode = 'other';
  }

  const nameMatch = userName.match(/[-–—]\s*(.+)$/);
  if (nameMatch) {
    const chineseName = nameMatch[1].trim();
    const pinyinName = chineseToPinyin(chineseName);
    return `${deptCode}_${pinyinName}`;
  }

  return chineseToPinyin(userName);
}

// ========== 批量队列 ==========

function queueLogWrite(queueKey: string, logFile: string, data: any): void {
  const logLine = JSON.stringify(data);
  const lineBytes = Buffer.byteLength(logLine, 'utf8');

  if (!logQueues[queueKey]) {
    logQueues[queueKey] = [];
    queueSizes[queueKey] = 0;
    callCounters[queueKey] = 0;
  }

  logQueues[queueKey].push(logLine);
  queueSizes[queueKey] += lineBytes;
  callCounters[queueKey] = (callCounters[queueKey] || 0) + 1;

  const shouldFlushNow =
    logQueues[queueKey].length >= FLUSH_CONFIG.maxLines ||
    queueSizes[queueKey] >= FLUSH_CONFIG.maxBytes ||
    callCounters[queueKey] >= FLUSH_CONFIG.callCountTrigger;

  if (shouldFlushNow) {
    if (flushTimers[queueKey]) {
      clearTimeout(flushTimers[queueKey]);
      flushTimers[queueKey] = null;
    }
    callCounters[queueKey] = 0;
    flushLogQueue(queueKey, logFile);
  } else if (!flushTimers[queueKey]) {
    flushTimers[queueKey] = setTimeout(() => {
      callCounters[queueKey] = 0;
      flushLogQueue(queueKey, logFile);
    }, FLUSH_CONFIG.maxDelayMs);
  }
}

function flushLogQueue(queueKey: string, logFile: string): void {
  if (!logQueues[queueKey] || logQueues[queueKey].length === 0) return;

  const lines = logQueues[queueKey].join('\n') + '\n';
  const lineCount = logQueues[queueKey].length;

  logQueues[queueKey] = [];
  queueSizes[queueKey] = 0;
  flushTimers[queueKey] = null;

  try {
    fs.appendFileSync(logFile, lines);
    if (lineCount >= 50) {
      console.log(`[Logger] 批量写入 ${lineCount} 条日志 → ${path.basename(logFile)}`);
    }
  } catch (error) {
    console.error(`[Logger] 写入日志失败: ${error}`);
  }
}

// ========== 异步写入 ==========

function asyncWriteLog(logType: string, data: any, userName?: string): void {
  const todayDir = getTodayLogDir();
  const today = new Date().toISOString().split('T')[0];

  // 总览日志
  const allUsersLogFile = path.join(todayDir, `${logType}.jsonl`);
  queueLogWrite(`${logType}:all`, allUsersLogFile, data);

  // 用户专属日志
  if (userName && userName !== 'anonymous') {
    const userDir = getUserLogDir(userName);
    const userLogFile = path.join(userDir, `${logType}.jsonl`);
    queueLogWrite(`${logType}:${userName}`, userLogFile, data);
    updateUserProfile(userName, data, today);
  }
}

// ========== 用户画像 ==========

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
      dailyStats: {},
    });
  }

  const profile = userProfiles.get(userName)!;

  if (!profile.dailyStats[date]) {
    profile.dailyStats[date] = { queries: 0, errors: 0, skills: new Set(), tools: new Map() };
  }

  const todayStat = profile.dailyStats[date];

  switch (data.type) {
    case 'request':
      profile.totalQueries++;
      todayStat.queries++;
      break;
    case 'skill_invocation':
      if (data.skill_path) todayStat.skills.add(data.skill_path);
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
      profile.totalQueries++;
      todayStat.queries++;
      if (data.action) {
        const actionKey = `action:${data.action}`;
        const count = todayStat.tools.get(actionKey) || 0;
        todayStat.tools.set(actionKey, count + 1);
      }
      break;
  }

  profile.lastActive = date;
}

function saveUserProfiles(): void {
  const analyticsDir = path.join(LOGS_ROOT, 'analytics');
  if (!fs.existsSync(analyticsDir)) {
    fs.mkdirSync(analyticsDir, { recursive: true });
  }

  userProfiles.forEach((profile, userName) => {
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

    const safeFileName = convertUserNameToDirName(userName) + '-profile.json';
    const profileFile = path.join(analyticsDir, safeFileName);

    const serializedProfile = {
      ...profile,
      dailyStats: Object.fromEntries(
        Object.entries(profile.dailyStats).map(([date, stat]) => [
          date,
          { ...stat, skills: Array.from(stat.skills), tools: Object.fromEntries(stat.tools) },
        ])
      ),
    };

    try {
      fs.writeFileSync(profileFile, JSON.stringify(serializedProfile, null, 2));
    } catch (error) {
      console.error(`[Logger] 保存用户画像失败: ${error}`);
    }
  });
}

function startProfileSaveTimer(): void {
  if (profileSaveTimer) clearInterval(profileSaveTimer);
  profileSaveTimer = setInterval(() => {
    saveUserProfiles();
    console.log(`[Logger] 自动保存用户画像，当前活跃用户: ${userProfiles.size} 人`);
  }, FLUSH_CONFIG.profileSaveInterval);
}

// ========== 会话管理 ==========

export function getOrCreateSessionId(clientIp: string, userName: string = 'anonymous'): string {
  const sessionId = uuidv4();
  sessionMap.set(sessionId, {
    startTime: new Date(),
    userName,
    skills: new Set(),
    queries: [],
    errors: 0,
    tools: new Map(),
  });
  return sessionId;
}

// ========== 日志记录函数 ==========

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

  if (session) session.queries.push(data.rawInput);

  const logData = {
    timestamp: new Date().toISOString(),
    type: 'request',
    session_id: data.sessionId,
    client_ip: data.clientIp,
    raw_input: data.rawInput,
    intent_analysis: {
      detected_keywords: data.detectedKeywords || [],
      routed_skills: data.routedSkills || [],
      confidence: data.confidence || 0,
    },
  };

  asyncWriteLog('requests', logData, userName);

  // SQLite 双写
  if (dbInitialized) {
    dbLogRequest({
      timestamp: logData.timestamp,
      session_id: data.sessionId,
      user_name: userName,
      client_ip: data.clientIp,
      raw_input: data.rawInput,
      detected_keywords: data.detectedKeywords,
      routed_skills: data.routedSkills,
      confidence: data.confidence,
    }).catch(err => console.error('[Logger] DB写入失败:', err));
  }
}

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
    user_name: userName,
    skill_path: data.skillPath,
    tool_name: data.toolName,
    success: data.success,
    response_time_ms: data.responseTimeMs,
    content_length: data.contentLength || 0,
  };

  asyncWriteLog('skills', logData, userName);

  // SQLite 双写
  if (dbInitialized) {
    dbLogSkill({
      timestamp: logData.timestamp,
      session_id: data.sessionId,
      user_name: userName,
      skill_path: data.skillPath,
      tool_name: data.toolName,
      success: data.success,
      response_time_ms: data.responseTimeMs,
      content_length: data.contentLength,
    }).catch(err => console.error('[Logger] DB写入失败:', err));
  }
}

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
    skill: data.skill || null,
  }, userName);
}

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

  if (session) session.errors++;

  const logData = {
    timestamp: new Date().toISOString(),
    type: 'error',
    session_id: data.sessionId,
    error_category: data.errorCategory,
    severity: data.severity,
    error_message: data.errorMessage,
    context: data.context,
    recoverable: data.recoverable,
    user_impact: data.userImpact,
  };

  asyncWriteLog('errors', logData, userName);

  // SQLite 双写
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
      user_impact: data.userImpact,
    }).catch(err => console.error('[Logger] DB写入失败:', err));
  }
}

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
    ...data,
  };

  asyncWriteLog('access', logData, userName);

  // SQLite 双写
  if (dbInitialized) {
    dbLogAccess({
      timestamp: logData.timestamp,
      session_id: data.sessionId,
      user_name: userName,
      ip_address: data.ip,
      action: data.action,
      user_agent: data.userAgent,
      response_time_ms: data.responseTimeMs,
      details: data,
    }).catch(err => console.error('[Logger] DB写入失败:', err));
  }
}

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
    completion_status: status,
  }, userName);

  saveUserProfiles();
  sessionMap.delete(sessionId);
}

// ========== 对话日志 ==========

function extractCacheInfo(projectPath: string): any {
  if (!projectPath) return null;
  const cacheDir = path.join(projectPath, '.wdp-cache');
  if (!fs.existsSync(cacheDir)) return { cache_dir: cacheDir, exists: false, files: [] };
  try {
    const files = fs.readdirSync(cacheDir);
    const fileDetails = files.map(file => {
      const filePath = path.join(cacheDir, file);
      const stat = fs.statSync(filePath);
      return { name: file, size: stat.size, modified: stat.mtime.toISOString() };
    });
    return { cache_dir: cacheDir, exists: true, files: fileDetails };
  } catch {
    return { cache_dir: cacheDir, exists: true, error: '读取缓存目录失败' };
  }
}

export function logConversation(data: {
  sessionId: string;
  userName?: string;
  userInput: string;
  toolName: string;
  toolArgs: any;
  scene: string;
  isScene5: boolean;
  projectPath?: string;
  backendCalls?: any[];
  responsePreview?: string;
}): void {
  const userName = data.userName || 'anonymous';
  const cacheInfo = data.projectPath ? extractCacheInfo(data.projectPath) : null;

  const logData = {
    timestamp: new Date().toISOString(),
    type: 'conversation',
    session_id: data.sessionId,
    user_name: userName,
    user_input: data.userInput,
    scene: data.scene,
    is_scene5_error_report: data.isScene5,
    tool: { name: data.toolName, args: data.toolArgs },
    project_path: data.projectPath,
    backend_calls: data.backendCalls || [],
    cache_info: cacheInfo,
    response_preview: data.responsePreview?.substring(0, 500),
  };

  asyncWriteLog('conversations', logData, userName);

  if (data.isScene5) {
    asyncWriteLog('error-reports', {
      ...logData,
      type: 'error_report',
      problem_description: data.userInput,
    }, userName);
  }

  console.error(`[Logger] 记录对话: ${data.toolName} | 场景: ${data.scene}${data.isScene5 ? ' | ⚠️场景5问题报告' : ''}`);
}

// ========== 清理 ==========

export function cleanupOldLogs(keepDays: number = 30): void {
  if (!fs.existsSync(LOGS_ROOT)) return;

  const dirs = fs.readdirSync(LOGS_ROOT);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - keepDays);

  dirs.forEach(dir => {
    const dirPath = path.join(LOGS_ROOT, dir);
    const stat = fs.statSync(dirPath);
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

// ========== 查询 ==========

export function getUserStats(userName: string): UserProfile | null {
  return userProfiles.get(userName) || null;
}

export function getActiveUsers(): string[] {
  return Array.from(userProfiles.keys());
}

export function getQueueStatus(): { [key: string]: { lines: number; bytes: number } } {
  const status: { [key: string]: { lines: number; bytes: number } } = {};
  Object.keys(logQueues).forEach(key => {
    status[key] = { lines: logQueues[key]?.length || 0, bytes: queueSizes[key] || 0 };
  });
  return status;
}

// ========== 优雅关闭 ==========

export function flushAllLogs(): void {
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
  saveUserProfiles();
}

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

// ========== 初始化 ==========

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

// ========== 启动 ==========
startProfileSaveTimer();

process.on('exit', flushAllLogs);
process.on('SIGINT', () => {
  flushAllLogs();
  if (profileSaveTimer) clearInterval(profileSaveTimer);
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushAllLogs();
  if (profileSaveTimer) clearInterval(profileSaveTimer);
  process.exit(0);
});