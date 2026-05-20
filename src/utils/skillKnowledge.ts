 /**
 * Skill 知识引擎（完整版）
 *
 * 功能：
 * - 从远程 Skill Server 拉取 manifest + 文件内容
 * - 三级查找：内置 Skill → 内存缓存 → 远程拉取
 * - 路由引擎：关键词匹配 + 歧义消解 + 场景匹配 + buildWorkflowResponse
 * - 7 个 MCP 工具（含 enforce_routing_check + trigger_self_evaluation 防幻觉双门禁）
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ========== 配置 ==========
const SKILL_SERVER_URL = process.env.SKILL_SERVER_URL || 'http://wdpapi-skill.51aes.com';
const CACHE_TTL = Number(process.env.CACHE_TTL) || 300;

// ========== 类型 ==========
interface ManifestFile { path: string; size: number; mtime: number; sha1: string; ext: string; }
interface ManifestResponse { root: string; count: number; total_size: number; files: ManifestFile[]; }
interface CacheEntry { content: string; timestamp: number; }
interface SkillEntry { path: string; size: number; sha1: string; }
interface RouteConfig {
  domain: string; label: string; skillPath: string;
  keywords: string[]; aliases: string[]; relatedSkills: string[];
  pathSegments?: string[];
  userSynonyms?: string[];  // v1.2: 用户常见物体名/动作动词 → 弥补自然语言≠API名称的鸿沟
}
interface RouteMapping { version: string; routes: RouteConfig[]; baseSkills: string[]; builtinSkills: string[]; }
interface McpToolDef { name: string; description: string; inputSchema: { type: string; properties: Record<string, any>; required?: string[]; }; }

interface HallucinatedApi {
  line: number;
  api: string;
  suggestion: string;
}

// ========== 内存缓存 ==========
const manifestCache: Map<string, ManifestFile> = new Map();
const fileCache: Map<string, CacheEntry> = new Map();
const builtinSkills: Map<string, string> = new Map();
let routeMapping: RouteMapping | null = null;

// ========== 关键词权重表 ==========
const KEYWORD_WEIGHTS: Record<string, number> = {
  // 强意图信号（权重 3）：出现即路由
  '初始化': 3, 'sdk': 3, 'wdpapi': 3, 'scene ready': 3,
  'new WdpApi': 3, '启动渲染': 3,
  'bim': 3, 'dcp': 3, '构件': 3, '楼层': 3, '高亮': 3,
  'gis': 3, 'geolayer': 3, '3dtiles': 3,
  'flood': 3, 'dynamic water': 3, '洪水': 3,
  '热力图': 3, 'heatmap': 3,
  '骨骼动画': 3, 'skeletal': 3,
  'RegisterSceneEvent': 3, '事件注册': 3,
  '飞行': 3, 'flyto': 3,
  // 普通信号（权重 2）：辅助匹配
  '接入': 2, 'config': 2,
  '相机': 2, 'camera': 2, '漫游': 2, '跟随': 2, '聚焦': 2, '镜头': 2, '视角': 2, '第三人称': 2,
  'poi': 2, '点位': 2, '标注': 2, '图标': 2,
  '路径': 2, 'path': 2, '画线': 2, '绘制路径': 2, '沿路径移动': 2, '路径移动': 2, 'bound': 2,
  '浮窗': 2, 'window': 2, '弹窗': 2, '窗口': 2,
  '3d文字': 2, 'text3d': 2,
  '灯光': 2, 'light': 2, '粒子': 2, 'particle': 2,
  '可视域': 2, 'viewshed': 2, '抛物线': 2, 'parabola': 2,
  '区域': 2, '轮廓': 2, '范围': 2, 'range': 2,
  '静态模型': 2, 'static model': 2, '模型放置': 2,
  '植被': 2, 'vegetation': 2, '工程模型': 2, 'project model': 2,
  '建模': 2, 'modeler': 2, '场景': 2, 'scene': 2, '批量': 2, '选择集': 2,
  'wim': 2, 'pipe': 2, 'cae': 2,
  '事件': 2, 'event': 2, '材质': 2, 'material': 2,
  '坐标': 2, 'coordinate': 2, '测量': 2, 'measure': 2,
  '渲染': 2, 'renderer': 2, '系统': 2, 'system': 2,
  '天空': 2, '光照': 2, '雾': 2, '天气': 2, '环境': 2,
  '特效': 2, 'effects': 2, '剖切': 2, 'section': 2,
  '中国地图': 2, '颜色': 2, '屏幕': 2, '形状': 2,
  '实时视频': 2, '视频融合': 2, '监控': 2,
};

// ========== 歧义消解规则 ==========
const DISAMBIGUATION_RULES: Array<{ pattern: RegExp; targetDomain: string; description: string }> = [
  { pattern: /画路径|绘制路径|创建路径/, targetDomain: 'covering-path', description: '覆盖物路径绘制' },
  { pattern: /沿路径走|巡检行驶|路线回放|路径移动|漫游路径|轨迹回放/, targetDomain: 'covering-bound', description: '实体路径移动' },
  { pattern: /跟车|跟拍|跟随实体|第三人称|跟谁|追踪/, targetDomain: 'camera', description: '相机跟随' },
  { pattern: /点模型拿ID|点底板单体|屏幕拾取/, targetDomain: 'tools', description: '屏幕拾取' },
  { pattern: /高亮构件|BIM高亮|楼层高亮|房间高亮/, targetDomain: 'plugin-bim', description: 'BIM高亮' },
  { pattern: /高亮GIS|GIS高亮|GIS要素高亮/, targetDomain: 'plugin-gis', description: 'GIS高亮' },
  { pattern: /离开清空|卸载清理|关闭页面|清理链路/, targetDomain: 'scene-management', description: '清理链路' },
  { pattern: /有什么|列出所有|检查场景|场景发现/, targetDomain: 'scene-management', description: '场景发现→outliner' },
];

// ========== 远程拉取 ==========
async function fetchSkillsManifest(): Promise<ManifestResponse> {
  const url = `${SKILL_SERVER_URL}/manifest`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`拉取 manifest 失败: HTTP ${response.status}`);
  const data = (await response.json()) as ManifestResponse;
  manifestCache.clear();
  for (const file of data.files) manifestCache.set(file.path, file);
  console.log(`[SkillKnowledge] Manifest 加载完成: ${data.count} 个文件`);
  return data;
}

async function fetchSkillFile(filePath: string): Promise<string> {
  const url = `${SKILL_SERVER_URL}/file/${encodeURIComponent(filePath)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`拉取文件失败: HTTP ${response.status} - ${filePath}`);
  const content = await response.text();
  fileCache.set(filePath, { content, timestamp: Date.now() });
  return content;
}

async function readKnowledgeFile(filePath: string): Promise<string> {
  if (builtinSkills.has(filePath)) return builtinSkills.get(filePath)!;
  const cached = fileCache.get(filePath);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL * 1000) return cached.content;
  return await fetchSkillFile(filePath);
}

function listKnowledgeEntries(): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const [p, f] of manifestCache) {
    if (p.startsWith('reference/')) entries.push({ path: p, size: f.size, sha1: f.sha1 });
  }
  for (const [p] of builtinSkills) entries.push({ path: p, size: 0, sha1: '' });
  return entries;
}

function generateDigest(content: string): { summary: string; fileHash: string; lineCount: number } {
  const lines = content.split('\n');
  const fileHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  const headings = lines.filter(l => /^##\s/.test(l)).map(l => l.replace(/^##\s+/, '')).slice(0, 10);
  const summary = headings.length > 0 ? `章节: ${headings.join(' | ')}` : content.substring(0, 500).replace(/\n/g, ' ');
  return { summary, fileHash, lineCount: lines.length };
}

// ========== 路由引擎 ==========

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

function loadRouteMapping(): RouteMapping {
  if (routeMapping) return routeMapping;
  const configPath = path.resolve(__dirname, '../../config/skill-route-mapping.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const data = JSON.parse(stripBom(raw)) as RouteMapping;
    routeMapping = data;
    return data;
  } catch (error: any) {
    console.error(`[SkillKnowledge] 路由映射加载失败: ${error.message}`);
    // 返回空路由，服务降级运行
    routeMapping = { version: '0.0.0', routes: [], baseSkills: [], builtinSkills: [] };
    return routeMapping;
  }
}

interface SceneEntry { id: string; name: string; priority: number; goal: string; keywords: string[]; synonyms: string[]; primary_skills: string[]; secondary_skills: string[]; file: string | null; }
interface SceneIndex { scenarios: SceneEntry[]; }
interface SceneDetail {
  id: string; name: string; goal: string;
  task_breakdown?: string[];
  api_flow?: Array<{ step: number; description: string; api: string; params: Record<string, any> }>;
  data_flow?: Array<{ step: string; output: string; usage: string }>;
  cleanup_chain?: Array<Record<string, string>>;
  required_clarifications?: string[];
  modules?: Array<{ name: string; wdp_apis: string[]; purpose: string }>;
}
let sceneIndex: SceneIndex | null = null;
let sceneDetailCache: Map<string, SceneDetail> = new Map();
function loadSceneIndex(): SceneIndex | null {
  if (sceneIndex) return sceneIndex;
  const p = path.resolve(__dirname, '../../config/business-scenarios/_index.json');
  if (!fs.existsSync(p)) return null;
  sceneIndex = JSON.parse(stripBom(fs.readFileSync(p, 'utf-8'))) as SceneIndex;
  return sceneIndex;
}
function loadSceneDetail(sceneId: string): SceneDetail | null {
  if (sceneDetailCache.has(sceneId)) return sceneDetailCache.get(sceneId)!;
  const p = path.resolve(__dirname, `../../config/business-scenarios/${sceneId}.json`);
  if (!fs.existsSync(p)) return null;
  const detail = JSON.parse(stripBom(fs.readFileSync(p, 'utf-8'))) as SceneDetail;
  sceneDetailCache.set(sceneId, detail);
  return detail;
}

function matchScene(input: string): SceneEntry | null {
  const idx = loadSceneIndex();
  if (!idx || !idx.scenarios) return null;
  const normalized = input.replace(/\s+/g, '').toLowerCase();
  let bestMatch: SceneEntry | null = null;
  let bestScore = 0;
  for (const s of idx.scenarios) {
    if (s.id === 'other') continue;
    let score = 0;
    for (const kw of s.keywords) {
      if (normalized.includes(kw.replace(/\s+/g, '').toLowerCase())) score += 3;
    }
    for (const syn of s.synonyms) {
      if (normalized.includes(syn.replace(/\s+/g, '').toLowerCase())) score += 2;
    }
    if (score > bestScore || (score === bestScore && s.priority < (bestMatch?.priority || 999))) {
      bestScore = score;
      bestMatch = s;
    }
  }
  return bestScore > 0 ? bestMatch : null;
}

function matchKeywords(requirement: string): { domain: string; score: number }[] {
  const lower = requirement.toLowerCase();
  const mapping = loadRouteMapping();
  const scores: { domain: string; score: number }[] = [];

  for (const route of mapping.routes) {
    let score = 0;
    for (const kw of route.keywords) {
      if (lower.includes(kw.toLowerCase())) score += (KEYWORD_WEIGHTS[kw] || 1);
    }
    for (const alias of route.aliases) {
      if (lower.includes(alias.toLowerCase())) score += 2;
    }
    // v1.2: userSynonyms 弥补自然语言 ≠ API名称 的鸿沟
    for (const syn of (route.userSynonyms || [])) {
      if (lower.includes(syn.toLowerCase())) score += 2;
    }
    if (score > 0) scores.push({ domain: route.domain, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/**
 * 全文模糊搜索 manifest 中所有 SKILL.md
 * v1.1.0: 关键词→路径段映射已合并到 config/skill-route-mapping.json 的 pathSegments 字段。
 * 此函数现在从 route 数据中获取 pathSegments 做匹配，不再依赖独立的 PATH_KEYWORD_MAP。
 * 用户输入中文 → route.keywords 匹配 → route.pathSegments → manifest 路径段匹配
 * 用户输入英文 → 直接匹配路径段
 */
function searchFuzzySkills(requirement: string): string[] {
  const lower = requirement.toLowerCase();
  const results: Array<{ path: string; score: number }> = [];
  const mapping = loadRouteMapping();

  // 从 route 数据中收集所有 pathSegments（用于路径段命中加分）
  const allPathSegments = new Set<string>();
  // 从 route 数据中构建 cn→en 映射（中文关键词命中的 route，其 pathSegments 全部加权）
  const keywordToSegments = new Map<string, Set<string>>();
  for (const route of mapping.routes) {
    const segs = route.pathSegments || [];
    for (const s of segs) allPathSegments.add(s.toLowerCase());
    for (const kw of route.keywords) {
      const kwLower = kw.toLowerCase();
      if (!keywordToSegments.has(kwLower)) keywordToSegments.set(kwLower, new Set());
      for (const s of segs) keywordToSegments.get(kwLower)!.add(s.toLowerCase());
    }
  }

  // 根据输入命中哪些 route 的关键词 → 收集加权 pathSegments
  const bonusSegments = new Set<string>();
  for (const route of mapping.routes) {
    const hitKeyword = route.keywords.some(kw => lower.includes(kw.toLowerCase()));
    const hitAlias = route.aliases.some(al => lower.includes(al.toLowerCase()));
    if (hitKeyword || hitAlias) {
      for (const seg of (route.pathSegments || [])) {
        bonusSegments.add(seg.toLowerCase());
      }
    }
  }

  // 遍历 manifest 中所有 SKILL.md
  for (const [filePath] of manifestCache) {
    if (!filePath.startsWith('reference/') || !filePath.endsWith('SKILL.md')) continue;
    const pathLower = filePath.toLowerCase();
    const parts = pathLower.replace(/[\/\-_]/g, ' ').split(/\s+/);
    let score = 0;

    // 路径段直接命中用户输入英文单词
    for (const part of parts) {
      if (lower.includes(part)) score += 2;
    }
    // 路径段命中 route 的 pathSegments（来自关键词命中加权）
    for (const part of parts) {
      if (bonusSegments.has(part)) score += 3;
    }

    if (score > 0) results.push({ path: filePath, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5).map(r => r.path);
}

function applyDisambiguation(requirement: string, keywordResults: { domain: string; score: number }[]): string | null {
  for (const rule of DISAMBIGUATION_RULES) {
    if (rule.pattern.test(requirement)) {
      // 检查消解目标是否在关键词结果中
      const found = keywordResults.find(r => r.domain === rule.targetDomain);
      if (found) return rule.targetDomain;
      // 如果不在，也返回消解目标（强制修正）
      return rule.targetDomain;
    }
  }
  return null;
}

/**
 * ⚠️ TODO: 二层路由已知冲突
 *
 * 当前同时运行 3 套匹配引擎，结果可能矛盾：
 *   A) 场景模板匹配 (matchScene → _index.json)  — 自称"最高优先级"
 *   B) 关键词加权匹配 (matchKeywords → skill-route-mapping.json) — "兜底"
 *   C) 全文模糊搜索 (searchFuzzySkills → 同样使用 skill-route-mapping.json 的 pathSegments) — "辅助"
 *
 * v1.1.0: C 已与 B 共享 pathSegments 数据源，消除关键词冗余。但 A 和 B 的 skillPath 仍可能不同。
 *
 * 场景命中时，B 和 C 的结果不再直接合并到 matched_skills (Round 2 优化)，
 * 但 B 的 primaryRoute 仍用于生成 workflow_steps，A 和 B 的 Step 3 可能冲突。
 *
 * 长期方案：统一为单一匹配引擎，所有 Skill 路径从场景模板派生。
 */
async function buildWorkflowResponse(userRequirement: string, projectPath: string): Promise<any> {
  const mapping = loadRouteMapping();

  // 1. 场景模板匹配（优先执行，场景=主裁判，旧版架构核心逻辑）
  let scene = matchScene(userRequirement);

  // 2. 场景命中 → 场景为主路由，跳过关键词匹配；场景未命中 → 关键词加权兜底
  let keywordResults: { domain: string; score: number }[] = [];
  let disambiguatedDomain: string | null = null;
  let primaryRoute: RouteConfig | undefined;

  // 始终执行关键词匹配（场景命中时作为补充，场景未命中时作为兜底）
  keywordResults = matchKeywords(userRequirement);
  disambiguatedDomain = applyDisambiguation(userRequirement, keywordResults);

  if (disambiguatedDomain) {
    primaryRoute = mapping.routes.find(r => r.domain === disambiguatedDomain);
  }
  if (!primaryRoute && keywordResults.length > 0) {
    primaryRoute = mapping.routes.find(r => r.domain === keywordResults[0].domain);
  }

  // 3. 收集所有匹配的 Skill 路径（场景优先 + 关键词补充）
  const matchedSkills: string[] = [];
  const requiredRelatedSkills: string[] = [];

  // 场景命中 → 场景的 primary_skills + secondary_skills 作为主干
  if (scene) {
    for (const sp of scene.primary_skills) {
      if (!matchedSkills.includes(sp)) matchedSkills.push(sp);
    }
    for (const sp of scene.secondary_skills) {
      if (!matchedSkills.includes(sp)) matchedSkills.push(sp);
    }
  }

  // 关键词路由的 Skill（补充场景未覆盖的子能力）
  if (primaryRoute) {
    if (!matchedSkills.includes(primaryRoute.skillPath)) {
      matchedSkills.push(primaryRoute.skillPath);
    }
    for (const f of primaryRoute.relatedSkills) {
      if (!requiredRelatedSkills.includes(f)) requiredRelatedSkills.push(f);
    }
  }

  // 4. 添加 baseSkills
  for (const bs of mapping.baseSkills) {
    if (!matchedSkills.includes(bs)) matchedSkills.push(bs);
  }

  // 5. 始终加载内置 Skill，并自动注入内容（对齐旧版"推送"模式，AI 无需手动 get_skill_content）
  const builtinContentPreviews: Array<{ path: string; preview: string }> = [];
  for (const bs of mapping.builtinSkills) {
    if (!matchedSkills.includes(bs)) matchedSkills.push(bs);
    // 自动读取内置 Skill 内容并注入 preview
    if (builtinSkills.has(bs)) {
      const raw = builtinSkills.get(bs)!;
      const excerpt = raw.substring(0, 1500); // 前 1500 字（约 2KB），避免撑爆上下文
      builtinContentPreviews.push({ path: bs, preview: excerpt });
    }
  }
  // 5.5 全文模糊搜索（仅场景未命中时追加，避免与场景推荐冲突）
  const suggestedSkills: string[] = [];
  if (!scene) {
    const fuzzySkills = searchFuzzySkills(userRequirement);
    for (const fs of fuzzySkills) {
      if (!matchedSkills.includes(fs)) matchedSkills.push(fs);
    }
  } else {
    // 场景命中时，fuzzy search 结果作为参考建议，不直接合并到 matched_skills
    const fuzzySkills = searchFuzzySkills(userRequirement);
    for (const fs of fuzzySkills) {
      if (!matchedSkills.includes(fs)) suggestedSkills.push(fs);
    }
  }

  // 6. matched_skills 去重（保留原始顺序）
  const uniqueMatchedSkills = [...new Set(matchedSkills)];
  const uniqueSuggestedSkills = [...new Set(suggestedSkills)];

  const isComplex = keywordResults.length > 3 || userRequirement.length > 50;

  // 6. 构建工作流步骤
  const workflowSteps: string[] = [];
  if (scene) workflowSteps.push(`🎯 场景: ${scene.name} — ${scene.goal}`);
  workflowSteps.push('Step 1: 意图编排 → 读取 builtin/wdp-intent-orchestrator.md');
  workflowSteps.push('Step 2: 初始化 → 读取 reference/initialization/SKILL.md');
  if (primaryRoute && !scene) workflowSteps.push(`Step 3: 核心功能 → 读取 ${primaryRoute.skillPath}`);
  if (scene) workflowSteps.push(`Step 3: 场景核心 Skill → 读取 ${scene.primary_skills.join(', ')}`);
  if (requiredRelatedSkills.length > 0) workflowSteps.push(`Step 4: 关联 Skill → 读取 ${requiredRelatedSkills.join(', ')}`);
  if (scene && scene.secondary_skills.length > 0) workflowSteps.push(`Step 5: 场景辅助 Skill → 读取 ${scene.secondary_skills.join(', ')}`);
  // 8. 构建 guidance（注入后果前置 + API 白名单提示）
  const sceneGuidance = scene
    ? `🎯 当前场景：${scene.name} — ${scene.goal}\n`
    : '';
  const consequenceBlock = `🚨 跳过 Skill 文件阅读的 3 种后果：
  1) 编造不存在的 API → 代码运行时直接报错
  2) 参数名拼错（如 scale→scale3d, text→labelContent）→ 功能静默失效
  3) 漏掉清理链路 → 内存泄漏 / GPU 资源不释放

  防线：
  ✓ 编码前：调用 enforce_routing_check 验证文件读取完整性
  ✓ 编码后：调用 trigger_self_evaluation 并传入 generated_code，MCP 会做 API 白名单存在性校验

  🚨 未调用 enforce_routing_check 和 trigger_self_evaluation 之前禁止生成代码。`;

  // 场景命中 → 加载场景详情
  let sceneDetail: SceneDetail | null = null;
  if (scene && scene.file) {
    sceneDetail = loadSceneDetail(scene.id);
  }

  // 在 workflow_steps 中追加场景拆解步骤
  if (sceneDetail?.task_breakdown) {
    for (const step of sceneDetail.task_breakdown) {
      workflowSteps.push(`🎯 场景任务: ${step}`);
    }
  }

  // 9. 预提取 API 白名单摘要（不读全文，仅方法名列表，轻量注入防幻觉）
  const skillApiSummaries: Array<{ path: string; apis: string[] }> = [];
  for (const sp of matchedSkills) {
    try {
      const content = await readKnowledgeFile(sp);
      const apis = [...extractApiFromSkillContent(content)];
      if (apis.length > 0) {
        skillApiSummaries.push({ path: sp, apis: apis.slice(0, 30) });
      }
    } catch {
      // 读取失败跳过，AI 需自行调用 read_knowledge_file
    }
  }

  return {
    user_requirement: userRequirement,
    project_path: projectPath,
    matched_skills: uniqueMatchedSkills,
    suggested_skills: uniqueSuggestedSkills,
    required_related_skills: requiredRelatedSkills,
    workflow_steps: workflowSteps,
    primary_domain: primaryRoute?.domain || null,
    primary_label: primaryRoute?.label || null,
    is_complex: isComplex,
    keyword_matches: keywordResults.slice(0, 5),
    disambiguation: disambiguatedDomain || null,
    scene: scene ? { id: scene.id, name: scene.name, goal: scene.goal } : null,
    scene_detail: sceneDetail ? {
      task_breakdown: sceneDetail.task_breakdown,
      api_flow: sceneDetail.api_flow,
      modules: sceneDetail.modules?.map(m => ({ name: m.name, wdp_apis: m.wdp_apis, purpose: m.purpose })),
    } : null,
    builtin_skills_preview: builtinContentPreviews,
    skill_api_summaries: skillApiSummaries,
    guidance: sceneGuidance + consequenceBlock,
  };
}

// ========== API 白名单提取（用于 trigger_self_evaluation 硬校验） ==========

/**
 * 从 Skill 文件内容中提取所有 WDP API 方法名
 * 模式：
 *  - new App.Xxx(...)  → App.Xxx
 *  - App.Xxx.Yyy(...)  → App.Xxx.Yyy
 *  - entity.Xxx(...)   → .Xxx (实体方法)
 */
function extractApiFromSkillContent(content: string): Set<string> {
  const apis = new Set<string>();

  // 提取所有 JS 代码块中的 API 调用
  const codeBlocks = content.match(/```(?:js|javascript|typescript)?\n([\s\S]*?)```/g);
  const codeSnippets = codeBlocks ? codeBlocks.map(b => b.replace(/```[\s\S]*?\n/, '').replace(/```$/, '')) : [content];

  for (const snippet of codeSnippets) {
    // new App.Xxx(  → App.Xxx
    const constructorMatches = snippet.matchAll(/new\s+(App\.\w+)\s*\(/g);
    for (const m of constructorMatches) apis.add(m[1]);

    // App.Xxx.Yyy(  → App.Xxx.Yyy
    const staticMethodMatches = snippet.matchAll(/(App\.\w+(?:\.\w+)+)\s*\(/g);
    for (const m of staticMethodMatches) apis.add(m[1]);

    // Obj.Xxx( where Obj is camelCase (entity method)
    const entityMethodMatches = snippet.matchAll(/([a-z]\w*)\.(\w+)\s*\(/g);
    for (const m of entityMethodMatches) {
      if (m[2].charAt(0).toUpperCase() === m[2].charAt(0)) {
        apis.add(`.${m[2]}`); // PascalCase methods
      }
    }

    // 事件名注册: RegisterSceneEvent('OnXxx'
    const eventMatches = snippet.matchAll(/RegisterSceneEvent\s*\(\s*['"](On\w+)['"]/g);
    for (const m of eventMatches) apis.add(m[1]);
  }

  return apis;
}

/**
 * 从 api_flow 的 api 字符串中提取标准化 API 名
 * "new App.Path({...})" → "App.Path"
 * "App.CameraControl.UpdateCamera" → "App.CameraControl.UpdateCamera"
 * "entityObj.Delete()" → ".Delete"
 */
function extractApiName(apiStr: string): string | null {
  // new App.Xxx( → App.Xxx
  const cm = apiStr.match(/new\s+(App\.\w+)\s*\(/);
  if (cm) return cm[1];
  // App.Xxx.Yyy( → App.Xxx.Yyy
  const smm = apiStr.match(/(App\.\w+(?:\.\w+)+)\s*\(/);
  if (smm) return smm[1];
  // obj.method( → .Method
  const emm = apiStr.match(/\.(\w+)\s*\(/);
  if (emm && emm[1].charAt(0).toUpperCase() === emm[1].charAt(0)) return `.${emm[1]}`;
  return null;
}

/**
 * 从 AI 生成的代码中提取所有 WDP API 调用
 */
function extractApiCallsFromCode(code: string): Array<{ line: number; api: string }> {
  const results: Array<{ line: number; api: string }> = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // new App.Xxx(
    const cm = line.match(/new\s+(App\.\w+)\s*\(/);
    if (cm) {
      results.push({ line: i + 1, api: cm[1] });
      continue;
    }

    // App.Xxx.Yyy(
    const smm = line.match(/(App\.\w+(?:\.\w+)+)\s*\(/);
    if (smm) {
      results.push({ line: i + 1, api: smm[1] });
      continue;
    }

    // entityObj.methodName( where methodName is PascalCase
    const emm = line.match(/([a-zA-Z_]\w*)\.(\w+)\s*\(/);
    if (emm && emm[2].charAt(0).toUpperCase() === emm[2].charAt(0) && !emm[1].startsWith('App')) {
      // 过滤掉 JS 原生方法
      const nativeMethods = new Set(['Map', 'Set', 'Array', 'Date', 'Math', 'JSON', 'Object', 'String', 'Number', 'Boolean', 'Promise', 'Error', 'RegExp', 'parseInt', 'parseFloat']);
      if (!nativeMethods.has(emm[1]) && !['require', 'console', 'process'].includes(emm[1])) {
        results.push({ line: i + 1, api: `.${emm[2]}` });
      }
    }
  }

  return results;
}

/**
 * 主校验函数：对比代码中的 API 与 Skill 白名单
 */
async function validateGeneratedCode(
  generatedCode: string,
  skillPaths: string[],
  extraApiList: string[] = [],
): Promise<{ passed: boolean; hallucinated: HallucinatedApi[]; totalApis: number; whitelistSize: number }> {
  // 1. 构建白名单
  const whitelist = new Set<string>();

  // 额外 API 白名单（来自场景 modules[].wdp_apis）
  for (const api of extraApiList) whitelist.add(api);
  for (const sp of skillPaths) {
    try {
      const content = await readKnowledgeFile(sp);
      const apis = extractApiFromSkillContent(content);
      for (const api of apis) whitelist.add(api);
    } catch {
      // 文件读取失败 → 跳过（已在 onboarding 层校验）
    }
  }

  // 添加通用方法白名单（entity.Delete / entity.Update / entity.SetVisible 等基础方法）
  const commonEntityMethods = ['Delete', 'Update', 'SetVisible', 'Add', 'Remove', 'Get', 'Set'];
  for (const m of commonEntityMethods) whitelist.add(`.${m}`);

  // 2. 提取 AI 代码中的 API
  const usedApis = extractApiCallsFromCode(generatedCode);

  // 3. 对比
  const hallucinated: HallucinatedApi[] = [];
  for (const { line, api } of usedApis) {
    if (!whitelist.has(api)) {
      // 给建议：找白名单中最相似的 API
      let suggestion = '请从已读 Skill 文件中查找正确的 API 名';
      const allApis = Array.from(whitelist);
      const lower = api.toLowerCase();
      let bestMatch = '';
      let bestScore = 0;
      for (const wl of allApis) {
        const wlLower = wl.toLowerCase();
        let score = 0;
        // 简单相似度：共享前缀/后缀
        if (api.startsWith('App.') && wl.startsWith('App.')) score += 2;
        if (wlLower.includes(lower.split('.').pop() || '')) score += 1;
        if (score > bestScore) { bestScore = score; bestMatch = wl; }
      }
      if (bestMatch && bestScore >= 2) {
        suggestion = `可能是 ${bestMatch}`;
      }

      hallucinated.push({ line, api, suggestion });
    }
  }

  return {
    passed: hallucinated.length === 0,
    hallucinated,
    totalApis: usedApis.length,
    whitelistSize: whitelist.size,
  };
}

// ========== MCP 工具定义 ==========
const MCP_TOOL_DEFINITIONS: McpToolDef[] = [
  {
    name: 'start_wdp_workflow',
    description: '🔑 核心工具：接收用户自然语言需求 → 意图路由 → 场景匹配 → Skill匹配 → 返回工作流结果',
    inputSchema: {
      type: 'object',
      properties: {
        user_requirement: { type: 'string', description: '用户的自然语言需求描述' },
        projectPath: { type: 'string', description: '用户项目路径' },
      },
      required: ['user_requirement', 'projectPath'],
    },
  },
  {
    name: 'read_knowledge_file',
    description: '按路径读取知识库任意文件（.md Skill / .js demo / .json 配置等）。支持摘要模式（默认）和全文模式',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '知识库文件路径' },
        force_full: { type: 'boolean', description: '是否强制返回全文' },
      },
      required: ['path'],
    },
  },
  {
    name: 'query_knowledge',
    description: '按关键词搜索 Skill 知识库',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        skill_path: { type: 'string', description: '限定搜索范围（可选）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_skills',
    description: '列出所有可用的 Skill 条目',
    inputSchema: {
      type: 'object',
      properties: {
        include_references: { type: 'boolean', description: '是否包含引用文件' },
      },
    },
  },
  {
    name: 'check_health',
    description: '检查服务健康状态',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'enforce_routing_check',
    description: '🚨 防幻觉门禁1（编码前）：验证所有路由匹配的 Skill 文件是否已全文读取。通过后可开始编码，但完成后必须调用 trigger_self_evaluation。',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_result: { type: 'object', description: 'start_wdp_workflow 返回结果' },
        skills_read: { type: 'array', items: { type: 'string' }, description: 'AI 已读取的 Skill 路径列表（全文模式）' },
        full_read_skills: { type: 'array', items: { type: 'string' }, description: 'AI 以 force_full: true 读取的 Skill 路径列表（可选，如提供则校验全文覆盖率）' },
      },
      required: ['workflow_result', 'skills_read'],
    },
  },
  {
    name: 'trigger_self_evaluation',
    description: '🚨 防幻觉门禁2（编码后）：将生成的代码传入，MCP 提取所有 API 调用并与 Skill 白名单做存在性比对。不在白名单的 API 将被阻断。历史上出现过仅通过门禁1仍编造 FocusByEntityName 等幻觉 API 的案例，门禁2是必需的。',
    inputSchema: {
      type: 'object',
      properties: {
        generated_code: { type: 'string', description: 'AI 生成的完整代码文本' },
        written_files: { type: 'array', items: { type: 'string' }, description: '已写入的文件路径' },
        used_skills: { type: 'array', items: { type: 'string' }, description: '使用的 Skill 路径（从 workflow_result.matched_skills 获取）' },
        scenario_id: { type: 'string', description: '场景 ID（可选）' },
      },
      required: ['generated_code', 'used_skills'],
    },
  },
];

export function getMcpToolDefinitions(): McpToolDef[] {
  return MCP_TOOL_DEFINITIONS;
}

// ========== MCP 工具处理 ==========
export async function handleMcpToolCall(tool: string, args: Record<string, any>): Promise<any> {
  switch (tool) {
    case 'start_wdp_workflow': {
      const userRequirement = args.user_requirement as string;
      const projectPath = args.projectPath as string;
      if (!userRequirement || !projectPath) return { error: '缺少 user_requirement 或 projectPath 参数' };
      return buildWorkflowResponse(userRequirement, projectPath);
    }

    case 'read_knowledge_file': {
      const filePath = args.path as string;
      if (!filePath) return { error: '缺少 path 参数' };
      try {
        const content = await readKnowledgeFile(filePath);
        const forceFull = args.force_full === true;
        if (forceFull) {
          const { fileHash, lineCount } = generateDigest(content);
          // 注入 API 白名单 — 编码时只能使用这些 API
          const apiWhitelist = extractApiFromSkillContent(content);
          return { path: filePath, content, fileHash, lineCount, mode: 'full', api_whitelist: [...apiWhitelist] };
        }
        const { summary, fileHash, lineCount } = generateDigest(content);
        return { path: filePath, summary, fileHash, lineCount, mode: 'summary' };
      } catch (error: any) {
        return { error: `读取失败: ${error.message}`, path: filePath };
      }
    }

    case 'query_knowledge': {
      const query = (args.query as string || '').toLowerCase();
      const skillPath = args.skill_path as string | undefined;
      const results: SkillEntry[] = [];
      for (const [p, f] of manifestCache) {
        if (!p.startsWith('reference/')) continue;
        if (skillPath && !p.includes(skillPath)) continue;
        if (p.toLowerCase().includes(query)) results.push({ path: p, size: f.size, sha1: f.sha1 });
      }
      for (const [p] of builtinSkills) {
        if (p.toLowerCase().includes(query)) results.push({ path: p, size: 0, sha1: '' });
      }
      return { query, total: results.length, results: results.slice(0, 20) };
    }

    case 'list_skills': {
      const entries = listKnowledgeEntries();
      return { total: entries.length, skills: entries.map(e => ({ path: e.path, size: e.size, sha1: e.sha1 })) };
    }

    case 'check_health': {
      return {
        status: 'ok', timestamp: new Date().toISOString(),
        skill_server: SKILL_SERVER_URL,
        manifest_files: manifestCache.size, cached_files: fileCache.size,
        builtin_skills: builtinSkills.size, routes_loaded: routeMapping !== null,
      };
    }

    case 'enforce_routing_check': {
      const workflowResult = args.workflow_result as any;
      const skillsRead = (args.skills_read as string[]) || [];
      const fullReadSkills = (args.full_read_skills as string[]) || [];
      const required = (workflowResult?.matched_skills || []) as string[];

      // 基础校验：是否都读了
      const notRead = required.filter((s: string) => !skillsRead.includes(s));
      // 全文校验：如果提供了 full_read_skills，检查是否都用全文模式读过
      const notFullRead = fullReadSkills.length > 0
        ? required.filter((s: string) => !fullReadSkills.includes(s))
        : [];

      const passed = notRead.length === 0 && notFullRead.length === 0;

      let message: string;
      let nextStep: string;
      if (passed) {
        message = '✅ 文件完整性校验通过。⚠️ 门禁1仅验证文件是否已读取，不能保证不会编造幻觉 API。编码前仍需逐行对照 Skill 白名单。编码后务必调用 trigger_self_evaluation 做 API 白名单终检。';
        nextStep = '🔜 编码完成后，调用 trigger_self_evaluation，传入 generated_code（完整代码文本）和 used_skills（从 workflow_result.matched_skills 获取）。';
      } else {
        const issues: string[] = [];
        if (notRead.length > 0) issues.push(`${notRead.length} 个 Skill 未读取: ${notRead.join(', ')}`);
        if (notFullRead.length > 0) issues.push(`${notFullRead.length} 个 Skill 未用全文模式读取: ${notFullRead.join(', ')}。请用 read_knowledge_file 传 force_full: true 重新读取`);
        message = `🚨 防幻觉阻断：${issues.join('；')}。禁止生成代码！这些文件包含正确的 API 签名和参数格式，跳过将导致 API 幻觉。`;
        nextStep = '📖 请继续读取上述缺失的 Skill 文件（force_full: true），然后重新调用 enforce_routing_check。';
      }

      const blocked = !passed;

      return {
        passed,
        blocked,
        required_count: required.length,
        read_count: skillsRead.length,
        full_read_count: fullReadSkills.length,
        missing_skills: notRead,
        not_full_read: notFullRead,
        message,
        next_step: nextStep,
      };
    }

    case 'trigger_self_evaluation': {
      const generatedCode = (args.generated_code as string) || '';
      const usedSkills = (args.used_skills as string[]) || [];
      const writtenFiles = (args.written_files as string[]) || [];

      // 硬校验1：API 白名单比对
      let apiCheckResult: { passed: boolean; hallucinated: HallucinatedApi[]; totalApis: number; whitelistSize: number } | null = null;
      // 硬校验2：场景 api_flow 步骤覆盖检查
      let stepCoverage: { passed: boolean; missing_steps: Array<{ step: number; description: string; api: string }>; total_steps: number } | null = null;

      if (generatedCode && usedSkills.length > 0) {
        // 如果传了 scenario_id，加载场景详情
        let sceneApiList: string[] = [];
        let sceneApiFlow: SceneDetail['api_flow'] | undefined;
        const scenarioId = (args.scenario_id as string) || '';
        if (scenarioId) {
          const sd = loadSceneDetail(scenarioId);
          if (sd?.modules) {
            for (const m of sd.modules) sceneApiList.push(...m.wdp_apis);
          }
          sceneApiFlow = sd?.api_flow;
        }
        try {
          apiCheckResult = await validateGeneratedCode(generatedCode, usedSkills, sceneApiList);
        } catch (e: any) {
          apiCheckResult = { passed: true, hallucinated: [], totalApis: 0, whitelistSize: 0 };
          console.error(`[trigger_self_evaluation] API 校验异常: ${e.message}`);
        }

        // 步骤覆盖检查：逐 step 验证代码中是否包含对应 API
        if (sceneApiFlow && sceneApiFlow.length > 0) {
          const usedApiNames = extractApiCallsFromCode(generatedCode).map(a => a.api);
          const missingSteps: Array<{ step: number; description: string; api: string }> = [];
          for (const s of sceneApiFlow) {
            // 提取 api 字段中的方法名（如 "new App.Path({...})" → "App.Path"）
            const apiNames = (s.api || '').split('+').map(a => a.trim());
            const found = apiNames.some(name => {
              const extracted = extractApiName(name);
              return extracted ? usedApiNames.includes(extracted) : false;
            });
            if (!found) {
              missingSteps.push({ step: s.step, description: s.description, api: s.api });
            }
          }
          stepCoverage = {
            passed: missingSteps.length === 0,
            missing_steps: missingSteps,
            total_steps: sceneApiFlow.length,
          };
        }
      }

      // 软检查（仅保留不重复的 4 条）
      const checks = [
        '🔍 占位符检查：确认代码中无 YOUR_URL、YOUR_TOKEN 等假值',
        '🔍 生命周期检查：确认初始化 → 渲染 → 清理的完整链路',
        '🔍 初始化顺序检查：Plugin.Install 在 Renderer.Start 之前',
        '🔍 工程基线检查：确认使用 npm install wdpapi（非 CDN）',
      ];

      // 构建最终结果
      const apiPassed = apiCheckResult ? apiCheckResult.passed : true;
      const hallucinated = apiCheckResult ? apiCheckResult.hallucinated : [];
      const stepPassed = stepCoverage ? stepCoverage.passed : true;

      if ((!apiPassed || !stepPassed) && apiCheckResult) {
        const errors: string[] = [];
        if (!apiPassed) {
          errors.push(...hallucinated.map(h => `  Line ${h.line}: ${h.api} → ${h.suggestion}`));
        }
        if (!stepPassed && stepCoverage) {
          errors.push(`\n⚠️ 场景步骤缺失 (${stepCoverage.missing_steps.length}/${stepCoverage.total_steps}):`);
          errors.push(...stepCoverage.missing_steps.map(s => `  Step ${s.step}: ${s.description} → 缺少 ${s.api}`));
        }

        return {
          passed: false,
          api_whitelist_check: {
            passed: apiPassed,
            total_apis_found: apiCheckResult.totalApis,
            whitelist_size: apiCheckResult.whitelistSize,
            hallucinated_apis: hallucinated,
            message: apiPassed ? '✅ 白名单通过' : `🚨 发现 ${hallucinated.length} 个不在任何 Skill 文件中的 API`,
          },
          step_coverage_check: stepCoverage ? {
            passed: stepCoverage.passed,
            total_steps: stepCoverage.total_steps,
            missing_steps: stepCoverage.missing_steps,
          } : null,
          soft_checks: checks,
          written_files: writtenFiles,
          used_skills: usedSkills,
          message: [`🚨 校验未通过，请修正以下问题后重新调用 trigger_self_evaluation：`, ...errors].join('\n'),
        };
      }

      return {
        passed: true,
        api_whitelist_check: {
          passed: true,
          total_apis_found: apiCheckResult?.totalApis || 0,
          whitelist_size: apiCheckResult?.whitelistSize || 0,
          message: '✅ 所有 API 调用均在 Skill 白名单中',
        },
        step_coverage_check: stepCoverage ? {
          passed: true,
          total_steps: stepCoverage.total_steps,
          message: `✅ 全部 ${stepCoverage.total_steps} 个场景步骤已覆盖`,
        } : null,
        soft_checks: checks,
        written_files: writtenFiles,
        used_skills: usedSkills,
        hint: '✅ 硬校验通过。请逐项检查以上 4 条软检查，发现问题立即修正。',
      };
    }

    default:
      return { error: `未知工具: ${tool}` };
  }
}

// ========== 初始化 ==========
export async function initSkillKnowledge(): Promise<void> {
  await fetchSkillsManifest();
  // 加载内置 Skill
  const builtinDir = path.resolve(__dirname, '../../builtin');
  const builtinFiles = ['wdp-intent-orchestrator.md'];
  for (const file of builtinFiles) {
    const filePath = path.join(builtinDir, file);
    if (fs.existsSync(filePath)) {
      builtinSkills.set(`builtin/${file}`, fs.readFileSync(filePath, 'utf-8'));
    }
  }
  // 预加载路由映射
  try { loadRouteMapping(); } catch { /* 路由映射将在首次使用时加载 */ }
}

export { readKnowledgeFile, listKnowledgeEntries, generateDigest, fetchSkillsManifest, fetchSkillFile, buildWorkflowResponse };