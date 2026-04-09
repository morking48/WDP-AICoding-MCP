/**
 * 首次使用提示模块
 * 
 * 检测是否首次使用，自动配置缓存存储路径
 * 注意：禁用交互式提示，避免干扰MCP协议的stdin/stdout通信
 */

const fs = require('fs');
const path = require('path');

const CACHE_CONFIG = require('../config/cache-config.json');

/**
 * 检测是否首次使用
 */
function isFirstUse() {
  // 检查环境变量或配置文件
  const configPath = path.join(getUserHome(), '.wdp-mcp-config.json');
  return !fs.existsSync(configPath);
}

/**
 * 获取用户主目录
 */
function getUserHome() {
  return process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH;
}

/**
 * 检测工程目录
 */
function detectProjectDir() {
  // 尝试从当前工作目录向上查找工程标志
  let currentDir = process.cwd();
  const maxDepth = 5;
  
  for (let i = 0; i < maxDepth; i++) {
    // 检查工程标志文件
    const markers = ['package.json', 'pom.xml', 'build.gradle', '.git', 'README.md'];
    for (const marker of markers) {
      if (fs.existsSync(path.join(currentDir, marker))) {
        return currentDir;
      }
    }
    
    // 向上级目录
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  
  return null;
}

/**
 * 确保目录存在
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 保存配置
 */
function saveConfig(config) {
  const configPath = path.join(getUserHome(), '.wdp-mcp-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * 加载配置
 */
function loadConfig() {
  const configPath = path.join(getUserHome(), '.wdp-mcp-config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return null;
}

/**
 * 获取缓存目录
 */
function getCacheDir() {
  const config = loadConfig();
  if (config && config.cacheDir) {
    return config.cacheDir;
  }
  return null;
}

/**
 * 显示首次使用提示（使用stderr，避免干扰MCP通信）
 */
function showFirstUsePromptSilent() {
  // 检查是否通过环境变量指定了缓存路径
  const envCacheDir = process.env.WDP_CACHE_DIR;
  if (envCacheDir) {
    const fullCacheDir = path.join(envCacheDir, CACHE_CONFIG.cacheDirName);
    ensureDir(fullCacheDir);
    saveConfig({
      cacheLocation: 'custom',
      cacheDir: fullCacheDir,
      firstUse: new Date().toISOString()
    });
    console.error(`[Cache] 使用环境变量指定的缓存目录: ${fullCacheDir}`);
    return fullCacheDir;
  }
  
  // 使用默认配置：优先工程目录，否则用户目录
  let cacheLocation = 'project';
  let cacheDir = detectProjectDir();
  
  if (!cacheDir) {
    cacheLocation = 'user';
    cacheDir = path.join(getUserHome(), '.wdp-cache');
  }
  
  // 创建缓存目录
  const fullCacheDir = path.join(cacheDir, CACHE_CONFIG.cacheDirName);
  ensureDir(fullCacheDir);
  
  // 保存配置
  saveConfig({
    cacheLocation,
    cacheDir: fullCacheDir,
    firstUse: new Date().toISOString()
  });
  
  // 使用 stderr 输出日志，避免干扰 MCP 协议的 stdout
  console.error(`[Cache] 首次使用，已自动创建缓存目录: ${fullCacheDir}`);
  console.error(`[Cache] 如需自定义路径，请设置环境变量 WDP_CACHE_DIR 后重启`);
  
  return fullCacheDir;
}

/**
 * 初始化缓存（如果不是首次使用，直接返回缓存目录）
 */
function initCache() {
  if (isFirstUse()) {
    return showFirstUsePromptSilent();
  }
  
  const cacheDir = getCacheDir();
  if (cacheDir && fs.existsSync(cacheDir)) {
    return cacheDir;
  }
  
  // 配置存在但目录被删除，重新创建
  console.error('[Cache] 缓存目录不存在，重新创建...');
  return showFirstUsePromptSilent();
}

module.exports = {
  isFirstUse,
  getCacheDir,
  initCache,
  detectProjectDir
};
