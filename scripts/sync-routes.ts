/**
 * Skill 路由同步检查脚本
 *
 * 用法：
 *   ts-node scripts/sync-routes.ts              → 输出完整报告
 *   ts-node scripts/sync-routes.ts --ci         → CI 模式（退出码 1 = 阻断）
 *   ts-node scripts/sync-routes.ts --json       → JSON 输出
 *   ts-node scripts/sync-routes.ts --fail-fast  → 遇到第一个阻断就退出
 *
 * 检查项：
 *   1. 路由 skillPath 在远程 manifest 中是否存在（不存在 = 🔴 阻断）
 *   2. relatedSkills 每条路径是否存在（不存在 = 🔴 阻断）
 *   3. 远程新增了哪些 SKILL.md 尚未路由（🟡 警告）
 *   4. KEYWORD_WEIGHTS 覆盖率（🟡 警告）
 *   5. business-scenarios 中引用的 skill_sequence 路径是否存在（🟡 警告）
 */

import * as fs from 'fs';
import * as path from 'path';

// ========== 配置 ==========
const SKILL_SERVER_URL = process.env.SKILL_SERVER_URL || 'http://wdpapi-skill.51aes.com';
const CONFIG_DIR = path.resolve(__dirname, '../config');
const ROUTE_MAPPING_PATH = path.join(CONFIG_DIR, 'skill-route-mapping.json');
const SCENARIOS_DIR = path.join(CONFIG_DIR, 'business-scenarios');

// ========== 类型 ==========
interface ManifestFile { path: string; size: number; mtime: number; sha1: string; ext: string; }
interface ManifestResponse { root: string; count: number; total_size: number; files: ManifestFile[]; }
interface RouteConfig { domain: string; label: string; skillPath: string; keywords: string[]; aliases: string[]; relatedSkills: string[]; sceneId?: string; }
interface RouteMapping { version: string; routes: RouteConfig[]; baseSkills: string[]; builtinSkills: string[]; }
interface SceneFile { metadata: { scenario_id: string; version: string; }; primary_skills: string[]; secondary_skills: string[]; modules: Array<{ wdp_apis: string[] }>; }

interface CheckResult {
  type: 'BLOCKER' | 'WARNING' | 'OK';
  category: string;
  message: string;
  detail?: string;
}

// ========== 远程拉取 ==========
async function fetchManifest(): Promise<ManifestResponse> {
  const url = `${SKILL_SERVER_URL}/manifest`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`拉取 manifest 失败: HTTP ${response.status}`);
  return (await response.json()) as ManifestResponse;
}

// ========== 本地加载 ==========
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

function loadRouteMapping(): RouteMapping {
  const raw = fs.readFileSync(ROUTE_MAPPING_PATH, 'utf-8');
  return JSON.parse(stripBom(raw)) as RouteMapping;
}

function loadScenarios(): SceneFile[] {
  if (!fs.existsSync(SCENARIOS_DIR)) return [];
  const files = fs.readdirSync(SCENARIOS_DIR).filter(f => f.endsWith('.json') && f !== '_index.json');
  return files.map(f => {
    const raw = fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf-8');
    return JSON.parse(stripBom(raw)) as SceneFile;
  });
}

// ========== 从 skillKnowledge.ts 提取 KEYWORD_WEIGHTS ==========
function extractKeywordWeights(): Set<string> {
  // 从源码中硬编码提取（避免 import 运行时依赖）
  const knownKeywords = new Set<string>();
  const weightsRaw = fs.readFileSync(path.resolve(__dirname, '../src/utils/skillKnowledge.ts'), 'utf-8');
  const match = weightsRaw.match(/KEYWORD_WEIGHTS[^=]*=\s*\{([^}]+)\}/s);
  if (match) {
    const pairs = match[1].matchAll(/'([^']+)'\s*:/g);
    for (const p of pairs) knownKeywords.add(p[1]);
  }
  return knownKeywords;
}

function extractDisambiguationDomains(): Set<string> {
  const raw = fs.readFileSync(path.resolve(__dirname, '../src/utils/skillKnowledge.ts'), 'utf-8');
  const domains = new Set<string>();
  const match = raw.match(/DISAMBIGUATION_RULES[^=]*=\s*\[([^\]]+)\]/s);
  if (match) {
    const targets = match[1].matchAll(/targetDomain:\s*'([^']+)'/g);
    for (const t of targets) domains.add(t[1]);
  }
  return domains;
}

// ========== 核心检查 ==========
async function runSyncCheck(): Promise<{ results: CheckResult[]; stats: any }> {
  const results: CheckResult[] = [];
  let blockerCount = 0;
  let warningCount = 0;

  console.log('🔍 WDP Skill 路由同步检查');
  console.log(`📡 Skill Server: ${SKILL_SERVER_URL}\n`);

  // 1. 拉取 manifest
  let manifest: ManifestResponse;
  try {
    manifest = await fetchManifest();
    console.log(`✅ Manifest 拉取成功: ${manifest.count} 个文件`);
  } catch (e: any) {
    results.push({ type: 'BLOCKER', category: 'MANIFEST', message: `无法拉取 manifest: ${e.message}` });
    return { results, stats: { blockerCount: 1, warningCount: 0 } };
  }

  const manifestFiles = new Set(manifest.files.map(f => f.path));
  const manifestSkillFiles = new Set(
    manifest.files.filter(f => f.path.startsWith('reference/') && f.path.endsWith('SKILL.md')).map(f => f.path)
  );
  const refSkillFiles = manifest.files.filter(f => f.path.startsWith('reference/') && f.path.endsWith('SKILL.md'));

  // 2. 加载本地配置
  let mapping: RouteMapping;
  try {
    mapping = loadRouteMapping();
    console.log(`✅ 路由映射加载成功: ${mapping.routes.length} 条路由`);
  } catch (e: any) {
    results.push({ type: 'BLOCKER', category: 'CONFIG', message: `路由映射加载失败: ${e.message}` });
    return { results, stats: { blockerCount: 1, warningCount: 0 } };
  }

  const keywordWeights = extractKeywordWeights();
  const disambiguationDomains = extractDisambiguationDomains();
  const scenarios = loadScenarios();

  // ====================================================================
  // 检查 1: 路由 skillPath 是否存在
  // ====================================================================
  console.log('\n--- 检查 1: 路由 skillPath 是否存在于 manifest ---');
  for (const route of mapping.routes) {
    if (!manifestFiles.has(route.skillPath)) {
      blockerCount++;
      results.push({
        type: 'BLOCKER',
        category: 'ROUTE_MISSING',
        message: `路由 [${route.domain}] 的 skillPath 不存在: ${route.skillPath}`,
        detail: `域: ${route.domain}, 标签: ${route.label}`,
      });
      console.log(`  🔴 ${route.domain}: ${route.skillPath} → 不存在`);
    }
  }
  if (blockerCount === results.filter(r => r.category === 'ROUTE_MISSING').length) {
    console.log('  🟢 所有路由 skillPath 有效');
  }

  // ====================================================================
  // 检查 2: relatedSkills 每条路径是否存在
  // ====================================================================
  console.log('\n--- 检查 2: relatedSkills 路径是否存在 ---');
  const initialBlockers = results.filter(r => r.type === 'BLOCKER').length;
  for (const route of mapping.routes) {
    for (const related of route.relatedSkills) {
      if (!manifestFiles.has(related)) {
        blockerCount++;
        results.push({
          type: 'BLOCKER',
          category: 'RELATED_MISSING',
          message: `路由 [${route.domain}] 的 relatedSkills 不存在: ${related}`,
          detail: `skillPath: ${route.skillPath}`,
        });
        console.log(`  🔴 ${route.domain} → ${related} 不存在`);
      }
    }
  }
  if (blockerCount === initialBlockers) console.log('  🟢 所有 relatedSkills 有效');

  // ====================================================================
  // 检查 3: 远程新增了哪些 SKILL.md 尚未路由
  // ====================================================================
  console.log('\n--- 检查 3: 新增 Skill（远程有，路由无）---');
  const routedSkillPaths = new Set<string>();
  for (const route of mapping.routes) {
    routedSkillPaths.add(route.skillPath);
    for (const r of route.relatedSkills) routedSkillPaths.add(r);
  }

  const unroutedSkills = refSkillFiles.filter(f => !routedSkillPaths.has(f.path));
  if (unroutedSkills.length > 0) {
    // 按目录分组
    const byDir: Record<string, string[]> = {};
    for (const f of unroutedSkills) {
      const parts = f.path.split('/');
      const dir = parts.slice(1, 3).join('/');
      if (!byDir[dir]) byDir[dir] = [];
      byDir[dir].push(f.path);
    }

    console.log(`  🟡 ${unroutedSkills.length} 个新增 SKILL.md 未路由:`);
    for (const [dir, files] of Object.entries(byDir).sort()) {
      console.log(`    ${dir}/ (${files.length} 个)`);
    }

    warningCount += unroutedSkills.length;
    results.push({
      type: 'WARNING',
      category: 'NEW_SKILLS',
      message: `远程有 ${unroutedSkills.length} 个 SKILL.md 未被路由覆盖`,
      detail: `按目录: ${Object.entries(byDir).map(([d, f]) => `${d}(${f.length})`).join(', ')}`,
    });
  } else {
    console.log('  🟢 无新增 Skill');
  }

  // ====================================================================
  // 检查 4: KEYWORD_WEIGHTS 覆盖率
  // ====================================================================
  console.log('\n--- 检查 4: KEYWORD_WEIGHTS 覆盖率 ---');
  const allKeywords = new Set<string>();
  for (const route of mapping.routes) {
    for (const kw of route.keywords) allKeywords.add(kw);
  }
  const keywordsWithoutWeight: string[] = [];
  for (const kw of allKeywords) {
    if (!keywordWeights.has(kw)) keywordsWithoutWeight.push(kw);
  }
  if (keywordsWithoutWeight.length > 0) {
    warningCount++;
    results.push({
      type: 'WARNING',
      category: 'KEYWORD_WEIGHTS',
      message: `${keywordsWithoutWeight.length} 个路由关键词缺少权重配置`,
      detail: keywordsWithoutWeight.slice(0, 20).join(', ') + (keywordsWithoutWeight.length > 20 ? '...' : ''),
    });
    console.log(`  🟡 ${keywordsWithoutWeight.length} 个关键词无权重: ${keywordsWithoutWeight.slice(0, 10).join(', ')}...`);
  } else {
    console.log('  🟢 所有路由关键词有权重');
  }

  // ====================================================================
  // 检查 5: 场景文件中的 skill 引用是否有效
  // ====================================================================
  console.log('\n--- 检查 5: 场景文件 skill 引用 ---');
  let sceneSkillIssues = 0;
  for (const scene of scenarios) {
    const allSkills = [...scene.primary_skills, ...scene.secondary_skills];
    for (const sp of allSkills) {
      if (!manifestSkillFiles.has(sp)) {
        sceneSkillIssues++;
        results.push({
          type: 'WARNING',
          category: 'SCENE_SKILL',
          message: `场景 [${scene.metadata.scenario_id}] 引用的 Skill 不存在: ${sp}`,
        });
      }
    }
  }
  if (sceneSkillIssues > 0) {
    warningCount++;
    console.log(`  🟡 ${sceneSkillIssues} 个场景 Skill 引用无效`);
  } else {
    console.log('  🟢 所有场景 Skill 引用有效');
  }

  // ====================================================================
  // 检查 7: disambiguation rules 指向的 domain 是否存在
  // ====================================================================
  console.log('\n--- 检查 7: 歧义消解规则 domain 有效性 ---');
  const routeDomains = new Set(mapping.routes.map(r => r.domain));
  let disambIssues = 0;
  for (const d of disambiguationDomains) {
    if (!routeDomains.has(d)) {
      disambIssues++;
      results.push({
        type: 'WARNING',
        category: 'DISAMBIGUATION',
        message: `歧义消解规则指向不存在的 domain: ${d}`,
      });
    }
  }
  if (disambIssues > 0) {
    warningCount++;
    console.log(`  🟡 ${disambIssues} 个消解规则 domain 不存在`);
  } else {
    console.log('  🟢 所有消解规则 domain 有效');
  }

  // ====================================================================
  // 统计汇总
  // ====================================================================
  const stats = {
    manifestTotal: manifest.count,
    manifestSkillFiles: refSkillFiles.length,
    routedSkills: mapping.routes.length,
    routedPlusRelated: routedSkillPaths.size,
    unroutedSkills: unroutedSkills.length,
    blockerCount,
    warningCount,
    totalResults: results.length,
  };

  return { results, stats };
}

// ========== 报告输出 ==========
function printReport(results: CheckResult[], stats: any) {
  const blockers = results.filter(r => r.type === 'BLOCKER');
  const warnings = results.filter(r => r.type === 'WARNING');

  console.log('\n═══════════════════════════════════════');
  console.log('📊 同步检查报告');
  console.log('═══════════════════════════════════════');
  console.log(`  Manifest: ${stats.manifestTotal} 文件 (${stats.manifestSkillFiles} SKILL.md)`);
  console.log(`  路由条目: ${stats.routedSkills} (含 relatedSkills 共覆盖 ${stats.routedPlusRelated} 路径)`);
  console.log(`  未路由 Skill: ${stats.unroutedSkills}`);
  console.log(`  🔴 阻断: ${blockers.length}  |  🟡 警告: ${warnings.length}`);
  console.log('═══════════════════════════════════════');

  if (blockers.length > 0) {
    console.log('\n🔴 阻断项（必须修复）：');
    for (const b of blockers) {
      console.log(`  [${b.category}] ${b.message}`);
      if (b.detail) console.log(`    → ${b.detail}`);
    }
  }

  if (warnings.length > 0) {
    console.log('\n🟡 警告项：');
    for (const w of warnings) {
      console.log(`  [${w.category}] ${w.message}`);
    }
  }

  if (blockers.length === 0 && warnings.length === 0) {
    console.log('\n🎉 全部检查通过！路由与 Skill Server 完全同步。');
  }
}

// ========== 主入口 ==========
async function main() {
  const args = process.argv.slice(2);
  const isCI = args.includes('--ci');
  const isJSON = args.includes('--json');

  let result: { results: CheckResult[]; stats: any };
  try {
    result = await runSyncCheck();
  } catch (e: any) {
    console.error(`\n❌ 检查执行失败: ${e.message}`);
    process.exit(2);
  }

  if (isJSON) {
    console.log(JSON.stringify({ stats: result.stats, results: result.results }, null, 2));
  } else {
    printReport(result.results, result.stats);
  }

  // CI 模式：有阻断 → exit 1
  if (isCI) {
    const blockers = result.results.filter(r => r.type === 'BLOCKER');
    if (blockers.length > 0) {
      console.log('\n❌ CI 检查失败：存在阻断项，阻止部署。');
      process.exit(1);
    }
    console.log('\n✅ CI 检查通过。');
    process.exit(0);
  }

  // 交互模式：有阻断也给出明确提示
  const blockers = result.results.filter(r => r.type === 'BLOCKER');
  if (blockers.length > 0) {
    console.log('\n⚠️  存在阻断项，请修复后再提交。');
  }
}

main().catch(console.error);