/**
 * Token 管理 CLI
 *
 * 用法：
 *   ts-node scripts/token-admin.ts list
 *   ts-node scripts/token-admin.ts add <token> <name>
 *   ts-node scripts/token-admin.ts remove <token>
 *   ts-node scripts/token-admin.ts disable <token> [reason]
 *   ts-node scripts/token-admin.ts enable <token>
 */

const SERVER_URL = process.env.WDP_SERVER_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret-token';

async function request(method: string, path: string, body?: any): Promise<any> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': ADMIN_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return await response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log('用法:');
    console.log('  ts-node scripts/token-admin.ts list');
    console.log('  ts-node scripts/token-admin.ts add <token> <name>');
    console.log('  ts-node scripts/token-admin.ts remove <token>');
    console.log('  ts-node scripts/token-admin.ts disable <token> [reason]');
    console.log('  ts-node scripts/token-admin.ts enable <token>');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'list': {
        const result = await request('GET', '/admin/tokens');
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'add': {
        const token = args[1];
        const name = args[2];
        if (!token || !name) {
          console.error('缺少参数: add <token> <name>');
          process.exit(1);
        }
        const result = await request('POST', '/admin/tokens', { token, name });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'remove': {
        const token = args[1];
        if (!token) {
          console.error('缺少参数: remove <token>');
          process.exit(1);
        }
        const result = await request('DELETE', `/admin/tokens/${encodeURIComponent(token)}`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'disable': {
        const token = args[1];
        const reason = args[2];
        if (!token) {
          console.error('缺少参数: disable <token> [reason]');
          process.exit(1);
        }
        const result = await request('POST', `/admin/tokens/${encodeURIComponent(token)}/disable`, { reason });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'enable': {
        const token = args[1];
        if (!token) {
          console.error('缺少参数: enable <token>');
          process.exit(1);
        }
        const result = await request('POST', `/admin/tokens/${encodeURIComponent(token)}/enable`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      default:
        console.error(`未知命令: ${command}`);
        process.exit(1);
    }
  } catch (error: any) {
    console.error('请求失败:', error.message);
    process.exit(1);
  }
}

main();