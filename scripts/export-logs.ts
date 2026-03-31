/**
 * 日志导出工具
 * 用法: npx ts-node scripts/export-logs.ts [命令] [参数]
 * 
 * 导出格式: CSV (可用Excel打开)
 * 
 * 环境变量:
 *   EXPORT_PATH - 自定义导出路径，如: D:\\analysis\\logs
 */

import { initDatabase, getDB } from '../src/utils/dbLogger';
import * as fs from 'fs';
import * as path from 'path';

const command = process.argv[2];
const arg = process.argv[3];

// 获取导出路径（支持环境变量或默认exports目录）
function getExportDir(): string {
  const envPath = process.env.EXPORT_PATH;
  if (envPath) {
    // 确保路径存在
    if (!fs.existsSync(envPath)) {
      fs.mkdirSync(envPath, { recursive: true });
    }
    return envPath;
  }
  // 默认路径
  const defaultDir = path.join(__dirname, '../exports');
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }
  return defaultDir;
}

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
    case 'export-user':
      if (!arg) {
        console.log('用法: npx ts-node scripts/export-logs.ts export-user <用户名>');
        return;
      }
      await exportUserData(arg);
      break;
    case 'export-all':
      await exportAllData();
      break;
    case 'export-csv':
      await exportToCSV(arg || 'all');
      break;
    default:
      showHelp();
  }
}

function showHelp() {
  console.log(`
日志导出工具

用法:
  npx ts-node scripts/export-logs.ts <命令> [参数]

命令:
  export-user <用户名>    导出指定用户的所有数据到JSON
  export-all              导出所有数据到JSON
  export-csv [用户名]     导出到CSV格式(可用Excel打开)，不指定用户则导出全部

环境变量（可选）:
  EXPORT_PATH             自定义导出路径，默认为 ./exports

示例:
  # 默认导出到 ./exports/
  npx ts-node scripts/export-logs.ts export-csv 客户A
  
  # 自定义导出路径
  set EXPORT_PATH=D:\\analysis\\logs
  npx ts-node scripts/export-logs.ts export-csv 客户A
  
  # PowerShell
  $env:EXPORT_PATH="D:\\analysis\\logs"
  npx ts-node scripts/export-logs.ts export-csv
`);
}

async function exportUserData(userName: string) {
  const db = getDB();
  if (!db) {
    console.log('数据库未初始化');
    return;
  }

  const exportDir = getExportDir();

  // 查询用户所有数据
  const tables = ['access_logs', 'request_logs', 'skill_logs', 'error_logs'];
  const userData: any = { userName, exportTime: new Date().toISOString() };

  for (const table of tables) {
    const rows = await new Promise<any[]>((resolve, reject) => {
      db.all(`SELECT * FROM ${table} WHERE user_name = ?`, [userName], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    userData[table] = rows;
    console.log(`导出 ${table}: ${rows.length} 条记录`);
  }

  // 保存到文件
  const fileName = `${userName}_export_${Date.now()}.json`;
  const filePath = path.join(exportDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(userData, null, 2), 'utf-8');
  
  console.log(`\n✅ 导出成功: ${filePath}`);
  console.log(`文件大小: ${(fs.statSync(filePath).size / 1024).toFixed(2)} KB`);
}

async function exportAllData() {
  const db = getDB();
  if (!db) {
    console.log('数据库未初始化');
    return;
  }

  const exportDir = getExportDir();

  const tables = ['access_logs', 'request_logs', 'skill_logs', 'error_logs', 'user_stats'];
  const allData: any = { exportTime: new Date().toISOString() };

  for (const table of tables) {
    const rows = await new Promise<any[]>((resolve, reject) => {
      db.all(`SELECT * FROM ${table}`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    allData[table] = rows;
    console.log(`导出 ${table}: ${rows.length} 条记录`);
  }

  const fileName = `all_data_export_${Date.now()}.json`;
  const filePath = path.join(exportDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(allData, null, 2), 'utf-8');
  
  console.log(`\n✅ 导出成功: ${filePath}`);
  console.log(`文件大小: ${(fs.statSync(filePath).size / 1024).toFixed(2)} KB`);
}

async function exportToCSV(userName: string) {
  const db = getDB();
  if (!db) {
    console.log('数据库未初始化');
    return;
  }

  const exportDir = getExportDir();

  // 导出访问日志为CSV
  const whereClause = userName === 'all' ? '' : `WHERE user_name = '${userName}'`;
  
  const rows = await new Promise<any[]>((resolve, reject) => {
    db.all(`
      SELECT 
        timestamp as '时间',
        user_name as '用户',
        action as '操作',
        ip_address as 'IP地址',
        response_time_ms as '响应时间(ms)'
      FROM access_logs
      ${whereClause}
      ORDER BY timestamp DESC
    `, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

  if (rows.length === 0) {
    console.log('没有数据可导出');
    return;
  }

  // 转换为CSV
  const headers = Object.keys(rows[0]).join(',');
  const csvRows = rows.map(row => {
    return Object.values(row).map(v => {
      // 处理包含逗号的字段
      const str = String(v || '');
      if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',');
  });
  
  const csvContent = '\uFEFF' + headers + '\n' + csvRows.join('\n'); // BOM for Excel
  
  const fileName = userName === 'all' 
    ? `all_access_logs_${Date.now()}.csv`
    : `${userName}_access_logs_${Date.now()}.csv`;
  const filePath = path.join(exportDir, fileName);
  fs.writeFileSync(filePath, csvContent, 'utf-8');
  
  console.log(`\n✅ CSV导出成功: ${filePath}`);
  console.log(`记录数: ${rows.length} 条`);
  console.log(`文件大小: ${(fs.statSync(filePath).size / 1024).toFixed(2)} KB`);
  console.log(`\n💡 提示: 可直接用Excel打开此CSV文件`);
}

main().catch(console.error);
