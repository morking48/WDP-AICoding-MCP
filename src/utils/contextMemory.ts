import path from 'path';
import fs from 'fs';

/**
 * Context Memory 存储层
 * 
 * 双层架构：
 * - System: 路由链路与知识快照（服务端自动维护文件存储，7天过期）
 * - Business: 业务逻辑记忆（AI大模型显式维护文件存储，30天过期）
 */

export function getCacheFilePath(projectPath: string, filename: string): string {
  return path.join(projectPath, '.wdp-cache', 'context-memory', filename);
}

export class ContextMemoryStore {
  private projectPath: string;
  private memoryDir: string;
  private isStorageAllowed: boolean = false;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.memoryDir = getCacheFilePath(projectPath, '');
    
    // 安全检查：如果是在公网服务器运行，禁止在系统关键目录下创建缓存
    this.isStorageAllowed = this.checkStoragePermission(projectPath);

    if (this.isStorageAllowed) {
      this.ensureDir();
      this.cleanupExpiredFiles();
    } else {
      console.warn(`[ContextMemory] 路径 ${projectPath} 被判定为非本地工程路径，持久化存储已禁用。`);
    }
  }

  private checkStoragePermission(p: string): boolean {
    // 1. 本地盘符检查 (Windows)
    if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
    
    // 2. 排除 Linux/Unix 系统关键目录，防止公网服务器被当成缓存站
    const sensitivePaths = ['/etc', '/opt', '/var', '/root', '/usr', '/bin', '/sbin'];
    const normalizedPath = path.resolve(p);
    
    // 如果是相对路径，或者是当前运行目录下的子目录，允许存储
    if (!path.isAbsolute(p)) return true;
    
    return !sensitivePaths.some(sp => normalizedPath.startsWith(sp));
  }

  private ensureDir() {
    if (!this.isStorageAllowed) return;
    try {
      if (!fs.existsSync(this.memoryDir)) {
        fs.mkdirSync(this.memoryDir, { recursive: true });
      }
    } catch (error) {
      console.error(`[ContextMemory] 创建缓存目录失败: ${this.memoryDir}`, error);
    }
  }

  // ========== 业务记忆层 (Business) ==========
  readBusinessMemory(): any {
    if (!this.isStorageAllowed) return {};
    const filePath = path.join(this.memoryDir, 'business.json');
    if (fs.existsSync(filePath)) {
      this.updateAccessTime('business');
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (error) {
        console.error(`[ContextMemory] 读取 business.json 失败:`, error);
        return {};
      }
    }
    return {};
  }

  writeBusinessMemory(data: any) {
    if (!this.isStorageAllowed) return;
    this.ensureDir();
    const filePath = path.join(this.memoryDir, 'business.json');
    try {
      let existingData = {};
      if (fs.existsSync(filePath)) {
        existingData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
      // 深度合并（简单实现：Object.assign，如果要处理嵌套可引入 lodash/merge 等，此处用展开语法浅层合并对象顶层属性）
      const newData = { ...existingData, ...data };
      fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf-8');
      this.updateAccessTime('business');
    } catch (error) {
      console.error(`[ContextMemory] 写入 business.json 失败:`, error);
    }
  }

  // ========== 系统层 (System) ==========
  readFile(layer: 'system' | 'business'): any {
    if (!this.isStorageAllowed) return {};
    
    const filePath = path.join(this.memoryDir, `${layer}.json`);
    if (fs.existsSync(filePath)) {
      this.updateAccessTime(layer);
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (error) {
        console.error(`[ContextMemory] 读取 ${layer}.json 失败:`, error);
        return {};
      }
    }
    return {};
  }

  writeFile(layer: 'system' | 'business', data: any) {
    if (!this.isStorageAllowed) return;
    this.ensureDir(); 
    
    const filePath = path.join(this.memoryDir, `${layer}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.updateAccessTime(layer);
    } catch (error) {
      console.error(`[ContextMemory] 写入 ${layer}.json 失败:`, error);
    }
  }

  // ========== 清理过期文件 (统一缓存管家) ==========
  private cleanupExpiredFiles() {
    const metaPath = path.join(this.memoryDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;

      // System: 7天过期
      if (meta.systemLastAccess && (now - meta.systemLastAccess) > 7 * DAY) {
        const sysPath = path.join(this.memoryDir, 'system.json');
        if (fs.existsSync(sysPath)) {
          fs.unlinkSync(sysPath);
          console.log('[ContextMemory] System 层已过期清理');
        }
      }

      // Business: 30天过期
      if (meta.businessLastAccess && (now - meta.businessLastAccess) > 30 * DAY) {
        const busPath = path.join(this.memoryDir, 'business.json');
        if (fs.existsSync(busPath)) {
          fs.unlinkSync(busPath);
          console.log('[ContextMemory] Business 业务记忆层已过期清理');
        }

      }
    } catch (error) {
      console.error('[ContextMemory] 清理过期文件失败:', error);
    }
  }

  private updateAccessTime(layer: string) {
    if (!this.isStorageAllowed) return;
    this.ensureDir(); // 确保写入 meta 前目录存在
    const metaPath = path.join(this.memoryDir, 'meta.json');
    try {
      let meta: any = {};
      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch (parseError) {
          console.error('[ContextMemory] 解析 meta.json 失败，将重建文件', parseError);
        }
      }
      meta[`${layer}LastAccess`] = Date.now();
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch (error) {
      console.error('[ContextMemory] 更新访问时间失败:', error);
    }
  }

  // ========== 手动清理 ==========
  cleanup(layer: 'all' | 'system' | 'business') {
    if (!this.isStorageAllowed) return;

    if (layer === 'all' || layer === 'system') {
      const sysPath = path.join(this.memoryDir, 'system.json');
      if (fs.existsSync(sysPath)) {
        fs.unlinkSync(sysPath);
        console.log('[ContextMemory] System 层已清理');
      }
    }

    if (layer === 'all' || layer === 'business') {
      const busPath = path.join(this.memoryDir, 'business.json');
      if (fs.existsSync(busPath)) {
        fs.unlinkSync(busPath);
        console.log('[ContextMemory] Business 业务层已清理');
      }
    }
  }
}

// ========== 全局存储实例管理 ==========
const contextMemoryStores = new Map<string, ContextMemoryStore>();

function normalizeProjectPath(p: string): string {
  if (!p) return '';
  // 统一转为绝对路径，并将所有反斜杠转为正斜杠，末尾不要斜杠
  return path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
}

export function getContextMemoryStore(projectPath: string): ContextMemoryStore {
  const normPath = normalizeProjectPath(projectPath);
  if (!normPath) throw new Error('[ContextMemory] projectPath 不能为空');
  
  if (!contextMemoryStores.has(normPath)) {
    contextMemoryStores.set(normPath, new ContextMemoryStore(normPath));
  }
  return contextMemoryStores.get(normPath)!;
}

export function cleanupContextMemory(projectPath: string) {
  const store = contextMemoryStores.get(projectPath);
  if (store) {
    contextMemoryStores.delete(projectPath);
    console.log(`[ContextMemory] 实例已注销: ${projectPath}`);
  }
}

export function cleanupAllContextMemory() {
  contextMemoryStores.clear();
  console.log(`[ContextMemory] 所有存储实例已注销`);
}
