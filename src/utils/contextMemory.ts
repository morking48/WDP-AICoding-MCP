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

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.memoryDir = path.join(projectPath, '.wdp-cache', 'context-memory');
    this.hotCache = new Map();
    this.ensureDir();
    this.cleanupExpiredFiles();
  }

  private ensureDir() {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
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
    const metaPath = path.join(this.memoryDir, 'meta.json');
    try {
      const meta = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        : {};
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
