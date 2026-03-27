#!/usr/bin/env node
/**
 * 日志分析脚本
 * 
 * 使用: npm run analytics [-- --date=2026-03-26]
 */

import fs from 'fs';
import path from 'path';

const LOGS_ROOT = path.resolve(__dirname, '../logs');
const ANALYTICS_DIR = path.resolve(__dirname, '../logs/analytics');
const AI_ANALYSIS_DIR = path.resolve(__dirname, '../logs/ai-analysis');

interface LogEntry {
  timestamp: string;
  type: string;
  [key: string]: any;
}

/**
 * 读取某天的日志文件
 */
function readLogFile(date: string, logType: string): LogEntry[] {
  const logFile = path.join(LOGS_ROOT, date, `${logType}.jsonl`);
  if (!fs.existsSync(logFile)) return [];
  
  const content = fs.readFileSync(logFile, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

/**
 * 分析日志数据
 */
function analyzeLogs(date: string) {
  const requests = readLogFile(date, 'requests');
  const skills = readLogFile(date, 'skills');
  const errors = readLogFile(date, 'errors');
  const sessions = readLogFile(date, 'sessions');
  
  // 统计热门Skill
  const skillStats: { [key: string]: number } = {};
  skills.forEach(log => {
    const skill = log.skill_path;
    skillStats[skill] = (skillStats[skill] || 0) + 1;
  });
  
  // 统计错误类型
  const errorStats: { [key: string]: { count: number; examples: any[] } } = {};
  errors.forEach(log => {
    const category = log.error_category;
    if (!errorStats[category]) {
      errorStats[category] = { count: 0, examples: [] };
    }
    errorStats[category].count++;
    if (errorStats[category].examples.length < 3) {
      errorStats[category].examples.push(log);
    }
  });
  
  // 统计用户输入关键词
  const keywordStats: { [key: string]: number } = {};
  requests.forEach(log => {
    const keywords = log.intent_analysis?.detected_keywords || [];
    keywords.forEach((kw: string) => {
      keywordStats[kw] = (keywordStats[kw] || 0) + 1;
    });
  });
  
  return {
    date,
    summary: {
      totalRequests: requests.length,
      totalSkills: skills.length,
      totalErrors: errors.length,
      totalSessions: sessions.length,
      errorRate: requests.length > 0 ? (errors.length / requests.length * 100).toFixed(2) + '%' : '0%'
    },
    skillStats,
    errorStats,
    keywordStats
  };
}

/**
 * 生成AI分析输入文件
 */
function generateAIAnalysis(analysis: any) {
  // 确保目录存在
  if (!fs.existsSync(AI_ANALYSIS_DIR)) {
    fs.mkdirSync(AI_ANALYSIS_DIR, { recursive: true });
  }
  
  // 1. Bug分析输入
  const bugAnalysis = {
    analysis_type: 'bug_analysis',
    date: analysis.date,
    total_errors: analysis.summary.totalErrors,
    error_rate: analysis.summary.errorRate,
    error_patterns: Object.entries(analysis.errorStats).map(([category, data]: [string, any]) => ({
      category,
      count: data.count,
      severity_distribution: { high: 0, medium: 0, low: 0 }, // 简化版
      examples: data.examples.map((e: any) => ({
        error_message: e.error_message,
        user_input: e.context?.userInput,
        workflow_step: e.context?.workflowStep
      })),
      suggested_fix: `检查${category}相关逻辑`
    }))
  };
  
  fs.writeFileSync(
    path.join(AI_ANALYSIS_DIR, `bug-analysis-${analysis.date}.json`),
    JSON.stringify(bugAnalysis, null, 2)
  );
  
  // 2. Skill覆盖分析
  const allSkills = Object.keys(analysis.skillStats);
  const hotSkills = allSkills
    .map(skill => ({ skill, count: analysis.skillStats[skill] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  
  const coldSkills = allSkills
    .map(skill => ({ skill, count: analysis.skillStats[skill] }))
    .filter(s => s.count <= 2)
    .slice(0, 10);
  
  const skillGapAnalysis = {
    analysis_type: 'skill_coverage',
    date: analysis.date,
    hot_skills: hotSkills,
    cold_skills: coldSkills,
    total_unique_skills: allSkills.length,
    recommendations: coldSkills.length > 0 
      ? `以下Skill很少被使用，考虑优化或移除: ${coldSkills.map(s => s.skill).join(', ')}`
      : '所有Skill都有一定使用量'
  };
  
  fs.writeFileSync(
    path.join(AI_ANALYSIS_DIR, `skill-gap-${analysis.date}.json`),
    JSON.stringify(skillGapAnalysis, null, 2)
  );
  
  // 3. 路由优化分析
  const routingAnalysis = {
    analysis_type: 'routing_optimization',
    date: analysis.date,
    total_requests: analysis.summary.totalRequests,
    top_keywords: Object.entries(analysis.keywordStats)
      .sort((a: any, b: any) => b[1] - a[1])
      .slice(0, 20),
    recommendations: '根据关键词分布，优化意图识别和Skill路由'
  };
  
  fs.writeFileSync(
    path.join(AI_ANALYSIS_DIR, `routing-optimization-${analysis.date}.json`),
    JSON.stringify(routingAnalysis, null, 2)
  );
}

/**
 * 生成日报
 */
function generateReport(analysis: any) {
  if (!fs.existsSync(ANALYTICS_DIR)) {
    fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
  }
  
  const report = `# WDP 知识库使用日报 - ${analysis.date}

## 数据概览

| 指标 | 数值 |
|------|------|
| 总请求数 | ${analysis.summary.totalRequests} |
| Skill调用次数 | ${analysis.summary.totalSkills} |
| 错误次数 | ${analysis.summary.totalErrors} |
| 会话数 | ${analysis.summary.totalSessions} |
| 错误率 | ${analysis.summary.errorRate} |

## 热门Skill Top 10

${Object.entries(analysis.skillStats)
  .sort((a: any, b: any) => b[1] - a[1])
  .slice(0, 10)
  .map(([skill, count], i) => `${i + 1}. ${skill}: ${count}次`)
  .join('\n')}

## 错误统计

${Object.entries(analysis.errorStats)
  .map(([category, data]: [string, any]) => `- **${category}**: ${data.count}次`)
  .join('\n') || '无错误记录'}

## 热门关键词 Top 20

${Object.entries(analysis.keywordStats)
  .sort((a: any, b: any) => b[1] - a[1])
  .slice(0, 20)
  .map(([kw, count], i) => `${i + 1}. ${kw}: ${count}次`)
  .join('\n')}

## AI分析文件

已生成以下文件供AI分析：
- logs/ai-analysis/bug-analysis-${analysis.date}.json
- logs/ai-analysis/skill-gap-${analysis.date}.json
- logs/ai-analysis/routing-optimization-${analysis.date}.json

使用方式：将这些文件内容发给AI，提示"请分析并给出优化建议"
`;

  fs.writeFileSync(
    path.join(ANALYTICS_DIR, `daily-report-${analysis.date}.md`),
    report
  );
}

/**
 * 主函数
 */
function main() {
  // 解析命令行参数
  const args = process.argv.slice(2);
  let date = new Date().toISOString().split('T')[0];
  
  args.forEach(arg => {
    if (arg.startsWith('--date=')) {
      date = arg.split('=')[1];
    }
  });
  
  console.log(`[Analytics] 分析日期: ${date}`);
  
  // 检查日志是否存在
  const logDir = path.join(LOGS_ROOT, date);
  if (!fs.existsSync(logDir)) {
    console.log(`[Analytics] 未找到 ${date} 的日志数据`);
    return;
  }
  
  // 分析日志
  const analysis = analyzeLogs(date);
  
  // 生成报告
  generateReport(analysis);
  generateAIAnalysis(analysis);
  
  console.log(`[Analytics] 分析完成！`);
  console.log(`[Analytics] 报告: logs/analytics/daily-report-${date}.md`);
  console.log(`[Analytics] AI分析文件: logs/ai-analysis/`);
}

main();
