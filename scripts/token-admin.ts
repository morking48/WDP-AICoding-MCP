#!/usr/bin/env node
/**
 * Token管理脚本
 * 
 * 用于动态管理Token，无需重启服务
 * 
 * 使用方法:
 *   npm run token -- list                    # 列出所有Token
 *   npm run token -- add <token> <type> <name>    # 添加Token
 *   npm run token -- update <token> --type <type> # 更新Token权限
 *   npm run token -- delete <token>          # 删除Token
 */

// 使用Node.js 18+内置的fetch，不需要node-fetch

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token';

async function apiRequest(method: string, endpoint: string, body?: any) {
  const url = `${SERVER_URL}${endpoint}`;
  const options: any = {
    method,
    headers: {
      'X-Admin-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json'
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  const data: any = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  
  return data;
}

async function listTokens() {
  try {
    const data = await apiRequest('GET', '/admin/tokens');
    
    console.log('\n📋 Token列表\n');
    console.log(`总计: ${data.stats.total} (活跃: ${data.stats.active}, 禁用: ${data.stats.disabled})\n`);
    
    console.log('Token\t\t名称\t\t状态\t\t创建时间');
    console.log('─'.repeat(80));
    
    data.tokens.forEach((t: any) => {
      const date = new Date(t.createdAt).toLocaleDateString();
      const status = t.disabled ? '已禁用' : '活跃';
      console.log(`${t.token}\t${t.name}\t${status}\t${date}`);
    });
    
    console.log();
  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

async function addToken(token: string, name: string) {
  try {
    const data = await apiRequest('POST', '/admin/tokens', { token, name });
    console.log(`✅ ${data.message}`);
  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

async function updateToken(token: string, updates: { name?: string }) {
  try {
    const data = await apiRequest('PUT', `/admin/tokens/${token}`, updates);
    console.log(`✅ ${data.message}`);
  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

async function deleteToken(token: string) {
  try {
    const data = await apiRequest('DELETE', `/admin/tokens/${token}`);
    console.log(`✅ ${data.message}`);
  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

function showHelp() {
    console.log(`
🎫 WDP Token管理脚本

使用方法:
  npm run token -- <命令> [参数]

命令:
  list                    列出所有Token
  add <token> <name>      添加新Token
  update <token> --name   更新Token名称
  delete <token>          删除Token
  disable <token> [原因]  禁用Token
  enable <token>          启用Token

示例:
  npm run token -- list
  npm run token -- add abc123 客户A
  npm run token -- update abc123 --name 客户A-新名称
  npm run token -- disable abc123 欠费停用
  npm run token -- enable abc123
  npm run token -- delete abc123

环境变量:
  SERVER_URL    服务器地址 (默认: http://localhost:3000)
  ADMIN_TOKEN   管理员Token (默认: admin-secret-token)
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'list':
      await listTokens();
      break;
      
    case 'add':
      if (args.length < 3) {
        console.error('❌ 用法: npm run token -- add <token> <name>');
        process.exit(1);
      }
      await addToken(args[1], args[2]);
      break;
      
    case 'update':
      if (args.length < 4 || args[2] !== '--name') {
        console.error('❌ 用法: npm run token -- update <token> --name <new-name>');
        process.exit(1);
      }
      await updateToken(args[1], { name: args[3] });
      break;
      
    case 'delete':
      if (args.length < 2) {
        console.error('❌ 用法: npm run token -- delete <token>');
        process.exit(1);
      }
      await deleteToken(args[1]);
      break;
      
    default:
      showHelp();
  }
}

main();
