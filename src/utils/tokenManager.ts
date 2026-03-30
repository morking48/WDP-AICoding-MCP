/**
 * 动态Token权限管理器
 * 
 * 支持运行时动态添加、修改、删除Token，无需重启服务
 */

import fs from 'fs';
import path from 'path';

// Token权限类型 - 简化为仅启用/禁用
export interface TokenInfo {
  name: string;
  createdAt: string;
  updatedAt: string;
  disabled?: boolean;
  disabledAt?: string;
  disabledReason?: string;
}

// 敏感路径黑名单
const SENSITIVE_PATHS = [
  'wdp-internal-case-acquisition',
  'ONLINE_COVERAGE_AUDIT.md'
];

/**
 * 检查路径是否为敏感路径
 */
export function isSensitivePath(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return SENSITIVE_PATHS.some(sensitive => 
    lowerPath.includes(sensitive.toLowerCase())
  );
}

// Token存储
const TOKEN_STORE: Map<string, TokenInfo> = new Map();

// 持久化文件路径
const TOKEN_FILE = path.resolve(__dirname, '../../config/tokens.json');

// 管理员Token（用于管理接口）
let ADMIN_TOKEN: string = process.env.ADMIN_TOKEN || 'admin-secret-token';

/**
 * 初始化Token管理器
 */
export function initTokenManager(): void {
  // 从环境变量加载初始Token
  // 格式：VALID_TOKENS=token1:名称1,token2:名称2
  const rawTokens = process.env.VALID_TOKENS || '';
  if (rawTokens) {
    rawTokens.split(',').forEach(tokenConfig => {
      const [token, name] = tokenConfig.split(':');
      if (token) {
        addToken(token, name || '未命名', false);
      }
    });
  }
  
  // 从文件加载持久化的Token
  loadTokensFromFile();
  
  console.log(`[TokenManager] 已加载 ${TOKEN_STORE.size} 个Token`);
}

/**
 * 从文件加载Token
 */
function loadTokensFromFile(): void {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      Object.entries(data.tokens || {}).forEach(([token, info]: [string, any]) => {
        TOKEN_STORE.set(token, {
          name: info.name,
          createdAt: info.createdAt || new Date().toISOString(),
          updatedAt: info.updatedAt || new Date().toISOString(),
          disabled: info.disabled,
          disabledAt: info.disabledAt,
          disabledReason: info.disabledReason
        });
      });
      if (data.adminToken) {
        ADMIN_TOKEN = data.adminToken;
      }
    }
  } catch (error) {
    console.error('[TokenManager] 加载Token文件失败:', error);
  }
}

/**
 * 保存Token到文件
 */
function saveTokensToFile(): void {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const data = {
      adminToken: ADMIN_TOKEN,
      tokens: Object.fromEntries(TOKEN_STORE),
      updatedAt: new Date().toISOString()
    };
    
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[TokenManager] 保存Token文件失败:', error);
  }
}

/**
 * 添加Token
 */
export function addToken(
  token: string, 
  name: string,
  persist: boolean = true
): boolean {
  if (TOKEN_STORE.has(token)) {
    return false; // Token已存在
  }
  
  const now = new Date().toISOString();
  TOKEN_STORE.set(token, {
    name,
    createdAt: now,
    updatedAt: now
  });
  
  if (persist) {
    saveTokensToFile();
  }
  
  console.log(`[TokenManager] 添加Token: ${name}`);
  return true;
}

/**
 * 更新Token信息
 */
export function updateToken(
  token: string,
  updates: { name?: string }
): boolean {
  const info = TOKEN_STORE.get(token);
  if (!info) {
    return false; // Token不存在
  }
  
  if (updates.name) info.name = updates.name;
  info.updatedAt = new Date().toISOString();
  
  saveTokensToFile();
  console.log(`[TokenManager] 更新Token: ${info.name}`);
  return true;
}

/**
 * 删除Token
 */
export function deleteToken(token: string): boolean {
  if (!TOKEN_STORE.has(token)) {
    return false;
  }
  
  const info = TOKEN_STORE.get(token);
  TOKEN_STORE.delete(token);
  saveTokensToFile();
  
  console.log(`[TokenManager] 删除Token: ${info?.name}`);
  return true;
}

/**
 * 禁用Token
 */
export function disableToken(token: string, reason?: string): boolean {
  const info = TOKEN_STORE.get(token);
  if (!info) {
    return false;
  }
  
  info.disabled = true;
  info.disabledAt = new Date().toISOString();
  info.disabledReason = reason || '管理员禁用';
  info.updatedAt = new Date().toISOString();
  
  saveTokensToFile();
  console.log(`[TokenManager] 禁用Token: ${info.name}, 原因: ${info.disabledReason}`);
  return true;
}

/**
 * 启用Token
 */
export function enableToken(token: string): boolean {
  const info = TOKEN_STORE.get(token);
  if (!info) {
    return false;
  }
  
  info.disabled = false;
  delete info.disabledAt;
  delete info.disabledReason;
  info.updatedAt = new Date().toISOString();
  
  saveTokensToFile();
  console.log(`[TokenManager] 启用Token: ${info.name}`);
  return true;
}

/**
 * 验证Token并返回信息
 */
export function verifyToken(token: string): TokenInfo | null {
  return TOKEN_STORE.get(token) || null;
}

/**
 * 获取所有Token列表
 */
export function listTokens(): Array<{ token: string; info: TokenInfo }> {
  return Array.from(TOKEN_STORE.entries()).map(([token, info]) => ({
    token,
    info
  }));
}

/**
 * 检查Token是否被禁用
 */
export function isTokenDisabled(token: string): boolean {
  const info = TOKEN_STORE.get(token);
  return info?.disabled === true;
}

/**
 * 检查Token是否有效
 */
export function verifyTokenAccess(token: string): { valid: boolean; reason?: string } {
  const info = TOKEN_STORE.get(token);
  if (!info) return { valid: false, reason: '无效的Token' };
  
  if (info.disabled) {
    return { valid: false, reason: 'Token已被禁用' };
  }
  
  return { valid: true };
}

/**
 * 检查路径访问权限
 * 简化策略：已授权用户可以访问所有非敏感路径
 */
export function checkPathPermission(token: string, path: string): { allowed: boolean; reason?: string } {
  // 先检查Token有效性
  const tokenCheck = verifyTokenAccess(token);
  if (!tokenCheck.valid) {
    return { allowed: false, reason: tokenCheck.reason };
  }
  
  // 检查是否为敏感路径
  if (isSensitivePath(path)) {
    return { allowed: false, reason: '无权访问该资源' };
  }
  
  return { allowed: true };
}

/**
 * 获取Token状态说明
 */
export function getTokenPermissionDescription(token: string): string {
  const info = TOKEN_STORE.get(token);
  if (!info) return '未知Token';
  
  if (info.disabled) {
    return `已禁用 (${info.disabledReason || '无原因'})`;
  }
  
  return '已授权：可访问所有非敏感内容';
}

/**
 * 验证管理员Token
 */
export function verifyAdminToken(token: string): boolean {
  return token === ADMIN_TOKEN;
}

/**
 * 更新管理员Token
 */
export function updateAdminToken(newToken: string): void {
  ADMIN_TOKEN = newToken;
  saveTokensToFile();
  console.log('[TokenManager] 管理员Token已更新');
}

/**
 * 获取所有有效的Token字符串列表（用于兼容旧代码）
 */
export function getValidTokens(): string[] {
  return Array.from(TOKEN_STORE.keys());
}

/**
 * 获取Token统计信息
 */
export function getTokenStats(): {
  total: number;
  active: number;
  disabled: number;
} {
  const tokens = Array.from(TOKEN_STORE.values());
  return {
    total: tokens.length,
    active: tokens.filter(t => !t.disabled).length,
    disabled: tokens.filter(t => t.disabled).length
  };
}
