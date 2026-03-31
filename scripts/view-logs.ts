/**
 * 日志查看工具
 * 用法: npx ts-node scripts/view-logs.ts [命令] [参数]
 */

import { getUserTimeline, getUserStatsFromDB, getDB } from '../src/utils/dbLogger';
import { initDatabase, closeDatabase } from '../src/utils/dbLogger';

const command = process.argv[2];
const arg = process.argv[3];

async function main() {
  // 初始化数据库
  try {
    await initDatabase();
    console.log('[DB] 数据库连接成功\n');
  } catch (err) {
    console.error('[DB] 数据库连接失败:', err);
    return;
  }

  switch (command) {
    case 'list-users':
      await listUsers();
      break;
    case 'user-timeline':
      if (!arg) {
        console.log('用法: npx ts-node scripts/view-logs.ts user-timeline <用户名>');
        return;
      }
      await showUserTimeline(arg);
      break;
    case 'user-stats':
      if (!arg) {
        console.log('用法: npx ts-node scripts/view-logs.ts user-stats <用户名>');
        return;
      }
      await showUserStats(arg);
      break;
    case 'recent-access':
      await showRecentAccess(arg ? parseInt(arg) : 20);
      break;
    case 'errors':
      await showErrors(arg ? parseInt(arg) : 10);
      break;
    default:
      showHelp();
  }
}

function showHelp() {
  console.log(`
日志查看工具

用法:
  npx ts-node scripts/view-logs.ts <命令> [参数]

命令:
  list-users              列出所有用户
  user-timeline <用户名>   查看用户操作时间线
  user-stats <用户名>      查看用户统计
  recent-access [数量]     查看最近的访问记录 (默认20条)
  errors [数量]            查看最近的错误 (默认10条)

示例:
  npx ts-node scripts/view-logs.ts list-users
  npx ts-node scripts/view-logs.ts user-timeline 客户A
  npx ts-node scripts/view-logs.ts user-stats 客户A
  npx ts-node scripts/view-logs.ts recent-access 50
`);
}

async function listUsers() {
  const db = getDB();
  if (!db) {
    console.log('数据库未初始化');
    return;
  }

  db.all(`
    SELECT DISTINCT user_name, COUNT(*) as count 
    FROM access_logs 
    GROUP BY user_name 
    ORDER BY count DESC
  `, (err, rows) => {
    if (err) {
      console.error('查询失败:', err);
      return;
    }
    console.log('\n用户列表:');
    console.log('------------------------');
    rows.forEach((row: any) => {
      console.log(`${row.user_name}: ${row.count} 次操作`);
    });
  });
}

async function showUserTimeline(userName: string) {
  try {
    const timeline = await getUserTimeline(userName);
    console.log(`\n用户 "${userName}" 的操作时间线:`);
    console.log('=================================================');
    
    timeline.forEach((item: any) => {
      const time = new Date(item.timestamp).toLocaleString('zh-CN');
      console.log(`\n[${time}] ${item.type}`);
      if (item.content) console.log(`  内容: ${item.content}`);
      if (item.response_time_ms) console.log(`  响应时间: ${item.response_time_ms}ms`);
      if (item.error_message) console.log(`  错误: ${item.error_message}`);
    });
  } catch (err) {
    console.error('查询失败:', err);
  }
}

async function showUserStats(userName: string) {
  try {
    const stats = await getUserStatsFromDB(userName);
    if (!stats) {
      console.log(`用户 "${userName}" 没有统计记录`);
      return;
    }

    console.log(`\n用户 "${userName}" 的统计信息:`);
    console.log('=================================================');
    console.log(`总会话数: ${stats.total_sessions}`);
    console.log(`总查询数: ${stats.total_queries}`);
    console.log(`总错误数: ${stats.total_errors}`);
    console.log(`最后活跃: ${stats.last_active}`);
    
    if (stats.favorite_skills) {
      const skills = JSON.parse(stats.favorite_skills);
      console.log(`常用技能: ${skills.join(', ')}`);
    }
    
    if (stats.favorite_tools) {
      const tools = JSON.parse(stats.favorite_tools);
      console.log(`常用工具: ${tools.join(', ')}`);
    }
  } catch (err) {
    console.error('查询失败:', err);
  }
}

async function showRecentAccess(limit: number) {
  const db = getDB();
  if (!db) {
    console.log('数据库未初始化');
    return;
  }

  db.all(`
    SELECT timestamp, user_name, action, response_time_ms
    FROM access_logs
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], (err, rows) => {
    if (err) {
      console.error('查询失败:', err);
      return;
    }
    
    console.log(`\n最近的 ${limit} 条访问记录:`);
    console.log('=================================================');
    rows.forEach((row: any) => {
      const time = new Date(row.timestamp).toLocaleString('zh-CN');
      console.log(`[${time}] ${row.user_name} - ${row.action} (${row.response_time_ms}ms)`);
    });
  });
}

async function showErrors(limit: number) {
  const db = getDB();
  if (!db) {
    console.log('数据库未初始化');
    return;
  }

  db.all(`
    SELECT timestamp, user_name, error_category, severity, error_message
    FROM error_logs
    ORDER BY timestamp DESC
    LIMIT ?
  `, [limit], (err, rows) => {
    if (err) {
      console.error('查询失败:', err);
      return;
    }
    
    console.log(`\n最近的 ${limit} 条错误:`);
    console.log('=================================================');
    rows.forEach((row: any) => {
      const time = new Date(row.timestamp).toLocaleString('zh-CN');
      console.log(`\n[${time}] ${row.user_name} - ${row.severity}`);
      console.log(`  类别: ${row.error_category}`);
      console.log(`  信息: ${row.error_message}`);
    });
  });
}

main().catch(console.error);
