/**
 * 轻量级日志管理器
 * 
 * 特点：
 * - 异步批量写入，不阻塞主流程
 * - 按日期分文件，便于管理
 * - 自动清理旧日志
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// 日志根目录
const LOGS_ROOT = path.resolve(__dirname, '../../logs');

// 内存队列（批量写入）
const logQueues: { [key: string]: string[] } = {};
const flushTimers: { [key: string]: NodeJS.Timeout | null } = {};

// 会话管理（用于关联同一会话的日志）
const sessionMap = new Map<string, { startTime: Date; skills: Set<string>; errors: number }>();

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
 * 异步批量写入日志
 */
function asyncWriteLog(logType: string, data: any): void {
  const logDir = getTodayLogDir();
  const logFile = path.join(logDir, `${logType}.jsonl`);
  
  const logLine = JSON.stringify(data);
  
  if (!logQueues[logType]) {
    logQueues[logType] = [];
  }
  
  logQueues[logType].push(logLine);
  
  // 批量写入：每100ms或满100条时写入
  if (!flushTimers[logType]) {
    flushTimers[logType] = setTimeout(() => {
      flushLogQueue(logType, logFile);
    }, 100);
  }
  
  if (logQueues[logType].length >= 100) {
    if (flushTimers[logType]) {
      clearTimeout(flushTimers[logType]);
      flushTimers[logType] = null;
    }
    flushLogQueue(logType, logFile);
  }
}

/**
 * 刷新日志队列到文件
 */
function flushLogQueue(logType: string, logFile: string): void {
  if (!logQueues[logType] || logQueues[logType].length === 0) {
    return;
  }
  
  const lines = logQueues[logType].join('\n') + '\n';
  logQueues[logType] = [];
  flushTimers[logType] = null;
  
  try {
    fs.appendFileSync(logFile, lines);
  } catch (error) {
    console.error(`[Logger] 写入日志失败: ${error}`);
  }
}

/**
 * 生成或获取会话ID
 */
export function getOrCreateSessionId(clientIp: string): string {
  // 简单实现：使用IP+时间戳生成会话ID
  // 实际生产环境可以使用更复杂的逻辑
  const sessionKey = `${clientIp}_${Date.now()}`;
  const sessionId = uuidv4();
  
  sessionMap.set(sessionId, {
    startTime: new Date(),
    skills: new Set(),
    errors: 0
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
  detectedKeywords?: string[];
  routedSkills?: string[];
  confidence?: number;
}): void {
  asyncWriteLog('requests', {
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
  });
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
  asyncWriteLog('skills', {
    timestamp: new Date().toISOString(),
    type: 'skill_invocation',
    session_id: data.sessionId,
    skill_path: data.skillPath,
    tool_name: data.toolName,
    success: data.success,
    response_time_ms: data.responseTimeMs,
    content_length: data.contentLength || 0
  });
  
  // 更新会话统计
  const session = sessionMap.get(data.sessionId);
  if (session) {
    session.skills.add(data.skillPath);
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
  asyncWriteLog('workflows', {
    timestamp: new Date().toISOString(),
    type: 'workflow_step',
    session_id: data.sessionId,
    step: data.step,
    action: data.action,
    skill: data.skill || null
  });
}

/**
 * 记录错误日志
 */
export function logError(data: {
  sessionId: string;
  errorCategory: string;
  severity: 'high' | 'medium' | 'low';
  errorMessage: string;
  context: {
    userInput?: string;
    routedSkill?: string;
    suggestedSkills?: string[];
    workflowStep?: number;
    tokenType?: string;
    userName?: string;
  };
  recoverable: boolean;
  userImpact: string;
}): void {
  asyncWriteLog('errors', {
    timestamp: new Date().toISOString(),
    type: 'error',
    session_id: data.sessionId,
    error_category: data.errorCategory,
    severity: data.severity,
    error_message: data.errorMessage,
    context: data.context,
    recoverable: data.recoverable,
    user_impact: data.userImpact
  });
  
  // 更新会话统计
  const session = sessionMap.get(data.sessionId);
  if (session) {
    session.errors++;
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
  
  asyncWriteLog('sessions', {
    timestamp: endTime.toISOString(),
    type: 'session_end',
    session_id: sessionId,
    start_time: session.startTime.toISOString(),
    end_time: endTime.toISOString(),
    duration_ms: durationMs,
    skills_used: Array.from(session.skills),
    error_count: session.errors,
    completion_status: status
  });
  
  // 清理会话数据
  sessionMap.delete(sessionId);
}

/**
 * 强制刷新所有日志（程序退出前调用）
 */
export function flushAllLogs(): void {
  const logDir = getTodayLogDir();
  
  Object.keys(logQueues).forEach(logType => {
    const logFile = path.join(logDir, `${logType}.jsonl`);
    flushLogQueue(logType, logFile);
  });
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

// 程序退出前刷新日志
process.on('exit', flushAllLogs);
process.on('SIGINT', () => {
  flushAllLogs();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushAllLogs();
  process.exit(0);
});
