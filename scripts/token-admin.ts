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
    console.log(`总计: ${data.stats.total} (公开: ${data.stats.public}, 私有: ${data.stats.private})\n`);
    
    console.log('Token\t\t类型\t名称\t\t创建时间');
    console.log('─'.repeat(80));
    
    data.tokens.forEach((t: any) => {
      const date = new Date(t.createdAt).toLocaleDateString();
      console.log(`${t.token}\t${t.type}\t${t.name}\t${date}`);
    });
    
    console.log();
  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

async function addToken(token: string, type: string, name: string) {
  try {
    if (type !== 'public' && type !== 'private') {
      console.error('❌ 类型必须是 public 或 private');
      return;
    }
    
    const data = await apiRequest('POST', '/admin/tokens', { token, type, name });
    console.log(`✅ ${data.message}`);
  } catch (error: any) {
    console.error('❌ 错误:', error.message);
  }
}

async function updateToken(token: string, updates: { type?: string; name?: string }) {
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
  list                          列出所有Token
  add <token> <type> <name>    添加新Token
  update <token> [选项]        更新Token
    --type <public|private>    修改类型
    --name <name>              修改名称
  delete <token>               删除Token

示例:
  npm run token -- list
  npm run token -- add abc123 public 客户A
  npm run token -- update abc123 --type private
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
      if (args.length < 4) {
        console.error('❌ 用法: npm run token -- add <token> <type> <name>');
        process.exit(1);
      }
      await addToken(args[1], args[2], args[3]);
      break;
      
    case 'update':
      if (args.length < 4) {
        console.error('❌ 用法: npm run token -- update <token> --type <type> --name <name>');
        process.exit(1);
      }
      const updates: any = {};
      for (let i = 2; i < args.length; i += 2) {
        if (args[i] === '--type') updates.type = args[i + 1];
        if (args[i] === '--name') updates.name = args[i + 1];
      }
      await updateToken(args[1], updates);
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
