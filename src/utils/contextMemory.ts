import path from 'path';
import fs from 'fs';

/**
 * Context Memory 存储层
 * 
 * 三层架构：
 * - Hot: 运行时状态（内存存储）
 * - Warm: 路由链路（文件存储，7天过期）
 * - Cold: 业务数据（文件存储，30天过期）
 */

export class ContextMemoryStore {
  private projectPath: string;
  private memoryDir: string;
  private hotCache: Map<string, any>;
  private isStorageAllowed: boolean = false;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.memoryDir = path.join(projectPath, '.wdp-cache', 'context-memory');
    this.hotCache = new Map();
    
    // 安全检查：如果是在公网服务器运行，禁止在系统关键目录下创建缓存
    this.isStorageAllowed = this.checkStoragePermission(projectPath);

    if (this.isStorageAllowed) {
      this.ensureDir();
      this.cleanupExpiredFiles();
    } else {
      console.warn(`[ContextMemory] 路径 ${projectPath} 被判定为非本地工程路径，持久化存储已禁用，仅启用内存 Hot 缓存。`);
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

  // ========== Hot 层：内存存储 ==========
  readHot(key: string): any {
    return this.hotCache.get(key);
  }

  writeHot(key: string, value: any) {
    this.hotCache.set(key, value);
  }

  clearHot() {
    this.hotCache.clear();
  }

  getAllHot(): Record<string, any> {
    return Object.fromEntries(this.hotCache);
  }

  // ========== Warm/Cold 层：文件存储 ==========
  readFile(layer: 'warm' | 'cold'): any {
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

  writeFile(layer: 'warm' | 'cold', data: any) {
    if (!this.isStorageAllowed) return;
    this.ensureDir(); // 确保写入前目录存在，防止运行时被用户手动删除
    const filePath = path.join(this.memoryDir, `${layer}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      this.updateAccessTime(layer);
    } catch (error) {
      console.error(`[ContextMemory] 写入 ${layer}.json 失败:`, error);
    }
  }

  // ========== 清理过期文件 ==========
  private cleanupExpiredFiles() {
    const metaPath = path.join(this.memoryDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;

      // Warm: 7天过期
      if (meta.warmLastAccess && (now - meta.warmLastAccess) > 7 * DAY) {
        const warmPath = path.join(this.memoryDir, 'warm.json');
        if (fs.existsSync(warmPath)) {
          fs.unlinkSync(warmPath);
          console.log('[ContextMemory] Warm 层已过期清理');
        }
      }

      // Cold: 30天过期
      if (meta.coldLastAccess && (now - meta.coldLastAccess) > 30 * DAY) {
        const coldPath = path.join(this.memoryDir, 'cold.json');
        if (fs.existsSync(coldPath)) {
          fs.unlinkSync(coldPath);
          console.log('[ContextMemory] Cold 层已过期清理');
        }
      }
    } catch (error) {
      console.error('[ContextMemory] 清理过期文件失败:', error);
    }
  }

  private updateAccessTime(layer: 'warm' | 'cold') {
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
  cleanup(layer: 'all' | 'hot' | 'warm' | 'cold') {
    if (layer === 'all' || layer === 'hot') {
      this.clearHot();
      console.log('[ContextMemory] Hot 层已清理');
    }

    if (!this.isStorageAllowed) return;

    if (layer === 'all' || layer === 'warm') {
      const warmPath = path.join(this.memoryDir, 'warm.json');
      if (fs.existsSync(warmPath)) {
        fs.unlinkSync(warmPath);
        console.log('[ContextMemory] Warm 层已清理');
      }
    }

    if (layer === 'all' || layer === 'cold') {
      const coldPath = path.join(this.memoryDir, 'cold.json');
      if (fs.existsSync(coldPath)) {
        fs.unlinkSync(coldPath);
        console.log('[ContextMemory] Cold 层已清理');
      }
    }
  }
}

// ========== 全局存储实例管理 ==========
const contextMemoryStores = new Map<string, ContextMemoryStore>();

export function getContextMemoryStore(projectPath: string): ContextMemoryStore {
  if (!contextMemoryStores.has(projectPath)) {
    contextMemoryStores.set(projectPath, new ContextMemoryStore(projectPath));
  }
  return contextMemoryStores.get(projectPath)!;
}

export function cleanupContextMemory(projectPath: string) {
  const store = contextMemoryStores.get(projectPath);
  if (store) {
    store.clearHot();
    contextMemoryStores.delete(projectPath);
    console.log(`[ContextMemory] 已清理: ${projectPath}`);
  }
}

export function cleanupAllContextMemory() {
  contextMemoryStores.forEach((store, projectPath) => {
    store.clearHot();
    console.log(`[ContextMemory] 已清理: ${projectPath}`);
  });
  contextMemoryStores.clear();
}
