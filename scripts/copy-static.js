/**
 * 构建后复制静态资源 (config/ + builtin/) 到 dist/
 * 零外部依赖 — 全部使用 Node.js 内置 API
 */
const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-static] 跳过不存在的目录: ${src}`);
    return;
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[copy-static] ${src} → ${dest}`);
}

const root = path.resolve(__dirname, '..');
copyDir(path.join(root, 'config'), path.join(root, 'dist', 'config'));
copyDir(path.join(root, 'builtin'), path.join(root, 'dist', 'builtin'));