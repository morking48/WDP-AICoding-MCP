/**
 * 动态Token权限管理器
 * 
 * 支持运行时动态添加、修改、删除Token，无需重启服务
 */

import fs from 'fs';
import path from 'path';

// Token权限类型
export type TokenType = 'public' | 'private';

export interface TokenInfo {
  type: TokenType;
  name: string;
  createdAt: string;
  updatedAt: string;
  disabled?: boolean;
  disabledAt?: string;
  disabledReason?: string;
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
  const rawTokens = process.env.VALID_TOKENS || '';
  if (rawTokens) {
    rawTokens.split(',').forEach(tokenConfig => {
      const [token, type, name] = tokenConfig.split(':');
      if (token && type) {
        addToken(token, type as TokenType, name || '未命名', false);
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
          type: info.type,
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
  type: TokenType, 
  name: string,
  persist: boolean = true
): boolean {
  if (TOKEN_STORE.has(token)) {
    return false; // Token已存在
  }
  
  const now = new Date().toISOString();
  TOKEN_STORE.set(token, {
    type,
    name,
    createdAt: now,
    updatedAt: now
  });
  
  if (persist) {
    saveTokensToFile();
  }
  
  console.log(`[TokenManager] 添加Token: ${name} (${type})`);
  return true;
}

/**
 * 更新Token权限
 */
export function updateToken(
  token: string,
  updates: { type?: TokenType; name?: string }
): boolean {
  const info = TOKEN_STORE.get(token);
  if (!info) {
    return false; // Token不存在
  }
  
  if (updates.type) info.type = updates.type;
  if (updates.name) info.name = updates.name;
  info.updatedAt = new Date().toISOString();
  
  saveTokensToFile();
  console.log(`[TokenManager] 更新Token: ${info.name} (${info.type})`);
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
 * 检查路径访问权限
 * 新策略：所有用户都可以访问所有路径，但公开用户不能查询技术实现细节
 */
export function checkPathPermission(token: string, path: string): { allowed: boolean; reason?: string } {
  const info = TOKEN_STORE.get(token);
  if (!info) return { allowed: false, reason: '无效的Token' };
  
  // 检查Token是否被禁用
  if (info.disabled) {
    return { allowed: false, reason: 'Token已被禁用' };
  }
  
  // 所有用户（public/private）都可以访问所有路径
  // 权限差异在内容查询层面控制
  return { allowed: true };
}

/**
 * 检查是否可以查询skill详细内容（SKILL.md）
 * 公开用户：不能查询SKILL.md（只能读取GUIDE.md等使用指南）
 * 私有用户：可以查询所有内容
 */
export function canQuerySkillDetail(token: string): boolean {
  const info = TOKEN_STORE.get(token);
  if (!info) return false;
  if (info.disabled) return false;
  
  // 只有private用户可以查询SKILL.md详细内容
  return info.type === 'private';
}

/**
 * 检查是否可以查询使用指南（非SKILL.md文件）
 * 公开用户：可以读取GUIDE.md、OVERVIEW.md等使用指南
 * 私有用户：可以查询所有内容
 */
export function canQueryGuide(token: string): boolean {
  const info = TOKEN_STORE.get(token);
  if (!info) return false;
  if (info.disabled) return false;
  
  // public和private都可以读取使用指南
  return true;
}

/**
 * 获取推荐读取的文件路径
 * 根据token类型返回不同的文件路径
 */
export function getRecommendedPath(token: string, skillName: string): string {
  const info = TOKEN_STORE.get(token);
  if (!info || info.disabled) return `${skillName}/GUIDE.md`;
  
  if (info.type === 'private') {
    return `${skillName}/SKILL.md`;
  } else {
    // public用户推荐使用GUIDE.md
    return `${skillName}/GUIDE.md`;
  }
}

/**
 * 获取Token权限说明
 */
export function getTokenPermissionDescription(token: string): string {
  const info = TOKEN_STORE.get(token);
  if (!info) return '未知Token';
  
  if (info.disabled) {
    return `已禁用 (${info.disabledReason || '无原因'})`;
  }
  
  if (info.type === 'private') {
    return '完整权限：可访问所有内容，可查询skill详细内容';
  } else {
    return '体验权限：可访问所有内容，不可查询skill详细内容';
  }
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
  public: number;
  private: number;
  disabled: number;
} {
  const tokens = Array.from(TOKEN_STORE.values());
  return {
    total: tokens.length,
    public: tokens.filter(t => t.type === 'public' && !t.disabled).length,
    private: tokens.filter(t => t.type === 'private' && !t.disabled).length,
    disabled: tokens.filter(t => t.disabled).length
  };
}
