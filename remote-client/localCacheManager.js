/**
 * 本地缓存管理器
 * 
 * 管理 Skill 摘要的本地缓存
 * 包括：读取、写入、过期检测、更新检测
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_CONFIG = require('../config/cache-config.json');
const { getCacheDir } = require('./cachePrompt');

class LocalCacheManager {
  constructor(cacheDir) {
    this.cacheDir = cacheDir || getCacheDir();
    this.skillCacheFile = path.join(this.cacheDir, CACHE_CONFIG.skillCacheFile);
    this.sessionCacheFile = path.join(this.cacheDir, CACHE_CONFIG.sessionCacheFile);
    this.officialDocsIndexFile = path.join(this.cacheDir, CACHE_CONFIG.officialDocsIndexFile);
    
    // 确保缓存目录存在
    this.ensureDir(this.cacheDir);
  }

  /**
   * 确保目录存在
   */
  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 读取 Skill 缓存
   */
  async getSkill(skillPath) {
    try {
      const cache = this.loadSkillCache();
      const entry = cache.skills[skillPath];
      
      if (!entry) {
        return null;
      }

      // 检查是否过期
      if (this.isExpired(entry.lastAccessed)) {
        console.error(`[Cache] Skill ${skillPath} 已过期`);
        return null;
      }

      // 更新访问时间
      entry.lastAccessed = new Date().toISOString();
      entry.accessCount = (entry.accessCount || 0) + 1;
      await this.saveSkillCache(cache);

      console.error(`[Cache] 命中: ${skillPath}`);
      return entry;
    } catch (error) {
      console.error('[Cache] 读取缓存失败:', error);
      return null;
    }
  }

  /**
   * 写入 Skill 缓存
   */
  async setSkill(skillPath, data) {
    try {
      const cache = this.loadSkillCache();
      
      cache.skills[skillPath] = {
        digest: data.digest,
        fileHash: data.fileHash,
        lastAccessed: new Date().toISOString(),
        accessCount: 1,
        path: skillPath
      };

      await this.saveSkillCache(cache);
      console.error(`[Cache] 已保存: ${skillPath}`);
      return true;
    } catch (error) {
      console.error('[Cache] 写入缓存失败:', error);
      return false;
    }
  }

  /**
   * 检查文件是否需要更新
   */
  async needsUpdate(skillPath, serverFileHash) {
    try {
      const entry = await this.getSkill(skillPath);
      if (!entry) {
        return true; // 缓存不存在，需要更新
      }

      // 比较文件哈希
      if (entry.fileHash !== serverFileHash) {
        console.error(`[Cache] Skill ${skillPath} 已更新，需要重新获取`);
        return true;
      }

      return false; // 缓存有效，无需更新
    } catch (error) {
      console.error('[Cache] 检查更新失败:', error);
      return true; // 出错时默认需要更新
    }
  }

  /**
   * 加载 Skill 缓存
   */
  loadSkillCache() {
    if (fs.existsSync(this.skillCacheFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.skillCacheFile, 'utf-8'));
      } catch (error) {
        console.error('[Cache] 解析缓存文件失败:', error);
      }
    }
    
    // 返回默认结构
    return {
      version: CACHE_CONFIG.version,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skills: {}
    };
  }

  /**
   * 保存 Skill 缓存
   */
  async saveSkillCache(cache) {
    cache.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.skillCacheFile, JSON.stringify(cache, null, 2));
  }

  /**
   * 检查是否过期
   */
  isExpired(lastAccessed) {
    const lastDate = new Date(lastAccessed);
    const now = new Date();
    const diffDays = (now - lastDate) / (1000 * 60 * 60 * 24);
    return diffDays > CACHE_CONFIG.cacheExpiryDays;
  }

  /**
   * 获取会话状态
   */
  async getSessionState() {
    try {
      if (fs.existsSync(this.sessionCacheFile)) {
        return JSON.parse(fs.readFileSync(this.sessionCacheFile, 'utf-8'));
      }
    } catch (error) {
      console.error('[Cache] 读取会话状态失败:', error);
    }
    return null;
  }

  /**
   * 保存会话状态
   */
  async setSessionState(state) {
    try {
      const data = {
        ...state,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.sessionCacheFile, JSON.stringify(data, null, 2));
      return true;
    } catch (error) {
      console.error('[Cache] 保存会话状态失败:', error);
      return false;
    }
  }

  /**
   * 获取已读官方文档索引
   */
  async getOfficialDocsIndex() {
    try {
      if (fs.existsSync(this.officialDocsIndexFile)) {
        return JSON.parse(fs.readFileSync(this.officialDocsIndexFile, 'utf-8'));
      }
    } catch (error) {
      console.error('[Cache] 读取官方文档索引失败:', error);
    }
    return { docs: [] };
  }

  /**
   * 添加已读官方文档
   */
  async addOfficialDoc(docPath) {
    try {
      const index = await this.getOfficialDocsIndex();
      if (!index.docs.includes(docPath)) {
        index.docs.push(docPath);
        index.updatedAt = new Date().toISOString();
        fs.writeFileSync(this.officialDocsIndexFile, JSON.stringify(index, null, 2));
      }
      return true;
    } catch (error) {
      console.error('[Cache] 添加官方文档索引失败:', error);
      return false;
    }
  }

  /**
   * 清理过期缓存
   */
  async cleanup() {
    try {
      const cache = this.loadSkillCache();
      const originalCount = Object.keys(cache.skills).length;
      
      // 过滤过期项
      for (const [path, entry] of Object.entries(cache.skills)) {
        if (this.isExpired(entry.lastAccessed)) {
          delete cache.skills[path];
        }
      }
      
      const newCount = Object.keys(cache.skills).length;
      const removedCount = originalCount - newCount;
      
      if (removedCount > 0) {
        await this.saveSkillCache(cache);
        console.error(`[Cache] 清理完成，移除 ${removedCount} 个过期缓存`);
      }
      
      return removedCount;
    } catch (error) {
      console.error('[Cache] 清理缓存失败:', error);
      return 0;
    }
  }

  /**
   * 获取缓存统计
   */
  async getStats() {
    try {
      const cache = this.loadSkillCache();
      const skills = Object.values(cache.skills);
      
      return {
        totalSkills: skills.length,
        totalAccessCount: skills.reduce((sum, s) => sum + (s.accessCount || 0), 0),
        oldestAccess: skills.length > 0 ? 
          skills.reduce((min, s) => s.lastAccessed < min ? s.lastAccessed : min, skills[0].lastAccessed) : 
          null,
        newestAccess: skills.length > 0 ?
          skills.reduce((max, s) => s.lastAccessed > max ? s.lastAccessed : max, skills[0].lastAccessed) :
          null,
        cacheDir: this.cacheDir,
        cacheSize: this.getCacheSize()
      };
    } catch (error) {
      console.error('[Cache] 获取统计失败:', error);
      return null;
    }
  }

  /**
   * 获取缓存大小（MB）
   */
  getCacheSize() {
    try {
      let totalSize = 0;
      
      if (fs.existsSync(this.skillCacheFile)) {
        const stats = fs.statSync(this.skillCacheFile);
        totalSize += stats.size;
      }
      
      if (fs.existsSync(this.sessionCacheFile)) {
        const stats = fs.statSync(this.sessionCacheFile);
        totalSize += stats.size;
      }
      
      if (fs.existsSync(this.officialDocsIndexFile)) {
        const stats = fs.statSync(this.officialDocsIndexFile);
        totalSize += stats.size;
      }
      
      return (totalSize / 1024 / 1024).toFixed(2);
    } catch (error) {
      return '0.00';
    }
  }

  /**
   * 清空缓存
   */
  async clear() {
    try {
      if (fs.existsSync(this.skillCacheFile)) {
        fs.unlinkSync(this.skillCacheFile);
      }
      if (fs.existsSync(this.sessionCacheFile)) {
        fs.unlinkSync(this.sessionCacheFile);
      }
      if (fs.existsSync(this.officialDocsIndexFile)) {
        fs.unlinkSync(this.officialDocsIndexFile);
      }
      console.error('[Cache] 缓存已清空');
      return true;
    } catch (error) {
      console.error('[Cache] 清空缓存失败:', error);
      return false;
    }
  }
}

module.exports = { LocalCacheManager };
