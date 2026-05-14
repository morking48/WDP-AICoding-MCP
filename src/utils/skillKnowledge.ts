/**
 * Skill 知识引擎（完整版）
 *
 * 功能：
 * - 从远程 Skill Server 拉取 manifest + 文件内容
 * - 三级查找：内置 Skill → 内存缓存 → 远程拉取
 * - 路由引擎：关键词匹配 + 歧义消解 + 场景匹配 + buildWorkflowResponse
 * - 上下文记忆由客户端本地工具实现（write_context_state / read_context_state）
 * - 7 个 MCP 工具
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
}
interface RouteMapping { version: string; routes: RouteConfig[]; baseSkills: string[]; builtinSkills: string[]; }
interface McpToolDef { name: string; description: string; inputSchema: { type: string; properties: Record<string, any>; required?: string[]; }; }

// ========== 内存缓存 ==========
const manifestCache: Map<string, ManifestFile> = new Map();
const fileCache: Map<string, CacheEntry> = new Map();
const builtinSkills: Map<string, string> = new Map();
let routeMapping: RouteMapping | null = null;

// ========== 关键词权重表 ==========
const KEYWORD_WEIGHTS: Record<string, number> = {
  '初始化': 3, 'sdk': 3, 'wdpapi': 3, 'scene ready': 3,
  '相机': 2, 'camera': 2, 'flyto': 2, '漫游': 2, '跟随': 2,
  'poi': 2, '热力图': 3, 'heatmap': 3, '路径': 2, 'path': 2,
  '浮窗': 2, 'window': 2, '3d文字': 2, 'text3d': 2,
  '灯光': 2, 'light': 2, '粒子': 2, 'particle': 2,
  '可视域': 2, 'viewshed': 2, '抛物线': 2, 'parabola': 2,
  '静态模型': 2, 'static model': 2, '骨骼动画': 3, 'skeletal': 3,
  '植被': 2, 'vegetation': 2, '工程模型': 2, 'project model': 2,
  '建模': 2, 'modeler': 2, '场景': 2, 'scene': 2, '批量': 2, '选择集': 2,
  'bim': 3, 'dcp': 3, '构件': 3, '楼层': 3,
  'gis': 3, 'geolayer': 3, '3dtiles': 3,
  'wim': 2, 'flood': 3, 'pipe': 2, 'dynamic water': 3,
  '事件': 2, 'event': 2, '材质': 2, 'material': 2,
  '坐标': 2, 'coordinate': 2, '测量': 2, 'measure': 2,
  '渲染': 2, 'renderer': 2, '环境': 2, '天气': 2,
  '特效': 2, 'effects': 2, '剖切': 2, 'section': 2,
  '中国地图': 2, '颜色': 2, '屏幕': 2, '形状': 2,
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

function loadRouteMapping(): RouteMapping {
  if (routeMapping) return routeMapping;
  const configPath = path.resolve(__dirname, '../../config/skill-route-mapping.json');
  const data = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as RouteMapping;
  routeMapping = data;
  return data;
}

let apiPatternsCache: any[] | null = null;
function loadApiPatterns(): any[] {
  if (!apiPatternsCache) {
    const p = path.resolve(__dirname, '../../config/api-patterns.json');
    apiPatternsCache = fs.existsSync(p) ? ((JSON.parse(fs.readFileSync(p, 'utf-8')) as any).patterns || []) : [];
  }
  return apiPatternsCache || [];
}

interface SceneEntry { id: string; name: string; priority: number; goal: string; keywords: string[]; synonyms: string[]; primary_skills: string[]; secondary_skills: string[]; file: string | null; }
interface SceneIndex { scenarios: SceneEntry[]; }
let sceneIndex: SceneIndex | null = null;
function loadSceneIndex(): SceneIndex | null {
  if (sceneIndex) return sceneIndex;
  const p = path.resolve(__dirname, '../../config/business-scenarios/_index.json');
  if (!fs.existsSync(p)) return null;
  sceneIndex = JSON.parse(fs.readFileSync(p, 'utf-8')) as SceneIndex;
  return sceneIndex;
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
    if (score > 0) scores.push({ domain: route.domain, score });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
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

function buildWorkflowResponse(userRequirement: string, projectPath: string): any {
  const mapping = loadRouteMapping();

  // 1. 场景模板匹配（优先执行，场景=主裁判，旧版架构核心逻辑）
  let scene = matchScene(userRequirement);

  // 2. 场景命中 → 场景为主路由，跳过关键词匹配；场景未命中 → 关键词加权兜底
  let keywordResults: { domain: string; score: number }[] = [];
  let disambiguatedDomain: string | null = null;
  let primaryRoute: RouteConfig | undefined;

  if (scene) {
    // 场景命中：直接使用场景的 primary_skills，不再浪费 CPU 做关键词匹配
    // 从 skill-route-mapping 中匹配 primary_skills[0] 对应的路由（获取 relatedSkills）
    const firstSceneSkill = scene.primary_skills[0] || '';
    primaryRoute = mapping.routes.find(r => r.skillPath === firstSceneSkill);
  } else {
    // 场景未命中 → 关键词加权兜底
    keywordResults = matchKeywords(userRequirement);
    disambiguatedDomain = applyDisambiguation(userRequirement, keywordResults);

    if (disambiguatedDomain) {
      primaryRoute = mapping.routes.find(r => r.domain === disambiguatedDomain);
    }
    if (!primaryRoute && keywordResults.length > 0) {
      primaryRoute = mapping.routes.find(r => r.domain === keywordResults[0].domain);
    }
  }

  // 3. 收集所有匹配的 Skill 路径
  const matchedSkills: string[] = [];
  const requiredRelatedSkills: string[] = [];

  // 场景命中 → 场景的 primary_skills + secondary_skills 直接作为主 Skill 列表
  if (scene) {
    for (const sp of scene.primary_skills) {
      if (!matchedSkills.includes(sp)) matchedSkills.push(sp);
    }
    for (const sp of scene.secondary_skills) {
      if (!matchedSkills.includes(sp)) matchedSkills.push(sp);
    }
  }

  // 关键词路由的 Skill（场景未覆盖时补充）
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
  const isComplex = keywordResults.length > 3 || userRequirement.length > 50;

  // 6. API 模式匹配
  const patterns = loadApiPatterns();
  let matchedPatterns: any[] = [];
  if (patterns.length > 0) {
    matchedPatterns = patterns.filter((p: any) =>
      p.skill_sequence && p.skill_sequence.some((sp: string) => matchedSkills.includes(sp)));
    matchedPatterns = matchedPatterns.slice(0, 2);
  }

  // 7. 构建工作流步骤
  const workflowSteps: string[] = [];
  if (scene) workflowSteps.push(`🎯 场景: ${scene.name} — ${scene.goal}`);
  if (isComplex) workflowSteps.push('Step 0: 长流程判断 → 启用 context-memory');
  workflowSteps.push('Step 1: 意图编排 → 读取 builtin/wdp-intent-orchestrator.md');
  workflowSteps.push('Step 2: 初始化 → 读取 reference/initialization/SKILL.md');
  if (primaryRoute && !scene) workflowSteps.push(`Step 3: 核心功能 → 读取 ${primaryRoute.skillPath}`);
  if (scene) workflowSteps.push(`Step 3: 场景核心 Skill → 读取 ${scene.primary_skills.join(', ')}`);
  if (requiredRelatedSkills.length > 0) workflowSteps.push(`Step 4: 关联 Skill → 读取 ${requiredRelatedSkills.join(', ')}`);
  if (scene && scene.secondary_skills.length > 0) workflowSteps.push(`Step 5: 场景辅助 Skill → 读取 ${scene.secondary_skills.join(', ')}`);
  if (matchedPatterns.length > 0) workflowSteps.push(`Step 6: API 调用模式 → ${matchedPatterns.map((p: any) => p.name).join(', ')}`);

  // 8. 构建 guidance（场景命中时注入场景信息到头部）
  const sceneGuidance = scene
    ? `🎯 当前场景：${scene.name} — ${scene.goal}\n`
    : '';
  const baseGuidance = isComplex
    ? '⚠️ 检测到复杂任务，建议启用 context-memory 保持跨轮对话状态。请先读取 builtin/wdp-intent-orchestrator.md 了解完整执行流程。🚨 在获取关键业务参数后，必须调用 write_context_state 保存到本地缓存。'
    : '🚨 请严格按 workflow_steps 顺序读取所有 Skill 文件，禁止跳过任何步骤。所有 WDP API 的正确签名和参数格式均以 Skill 文件为准，禁止凭记忆编造 API 调用。🚨 在获取关键业务参数后，必须调用 write_context_state 保存到本地缓存。';

  return {
    user_requirement: userRequirement,
    project_path: projectPath,
    matched_skills: matchedSkills,
    required_related_skills: requiredRelatedSkills,
    workflow_steps: workflowSteps,
    primary_domain: primaryRoute?.domain || null,
    primary_label: primaryRoute?.label || null,
    is_complex: isComplex,
    keyword_matches: keywordResults.slice(0, 5),
    disambiguation: disambiguatedDomain || null,
    scene: scene ? { id: scene.id, name: scene.name, goal: scene.goal } : null,
    api_patterns: matchedPatterns,
    builtin_skills_preview: builtinContentPreviews,
    activeContext: {
      layer: 'system',
      summary: `当前任务：${scene?.name || primaryRoute?.label || '未匹配'} | 关键 Skill: ${primaryRoute?.skillPath || '无'}`,
      data: {
        matchedSkills,
        requiredRelatedSkills,
        keywords: keywordResults.slice(0, 5).map(k => k.domain),
      },
      hint: '【架构记忆】这是本地缓存的原始设计意图，若后续步骤产生幻觉，请优先以此为准。若丢失路由，调用 read_context_state(layer="system") 恢复。',
    },
    _business_context: {
      layer: 'business',
      hint: '【业务参数记忆】IDE 客户端将从本地 .wdp-cache/context-memory/business.json 读取并注入。若为空，说明尚无业务缓存。请调用 read_context_state(layer="business") 检查。',
    },
    guidance: sceneGuidance + baseGuidance,
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
    description: '🚨 防幻觉核心校验工具：强制 AI 在生成代码前必须读取所有路由匹配的 Skill 文件。未通过此校验前，禁止生成任何 WDP API 代码。Skill 文件包含正确的 API 签名和 demo.js 代码示例，跳过阅读将导致 API 幻觉。',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_result: { type: 'object', description: 'start_wdp_workflow 返回结果' },
        skills_read: { type: 'array', items: { type: 'string' }, description: 'AI 已读取的 Skill 路径列表' },
      },
      required: ['workflow_result', 'skills_read'],
    },
  },
  {
    name: 'trigger_self_evaluation',
    description: '触发 AI 自我代码审查',
    inputSchema: {
      type: 'object',
      properties: {
        written_files: { type: 'array', items: { type: 'string' }, description: '已写入的文件路径' },
        used_skills: { type: 'array', items: { type: 'string' }, description: '使用的 Skill 路径' },
        scenario_id: { type: 'string', description: '场景 ID（可选）' },
      },
      required: ['written_files', 'used_skills'],
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
          return { path: filePath, content, fileHash, lineCount, mode: 'full' };
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
      const required = (workflowResult?.matched_skills || []) as string[];
      const missing = required.filter((s: string) => !skillsRead.includes(s));
      return {
        passed: missing.length === 0,
        required_count: required.length,
        read_count: skillsRead.length,
        missing_skills: missing,
        message: missing.length === 0
          ? '✅ 所有必需 Skill 已读取，API 签名已确认，可以安全生成代码。'
          : `🚨 防幻觉阻断：缺少 ${missing.length} 个 Skill 文件未读取。禁止生成代码！这些文件包含正确的 API 签名和参数格式，跳过将导致 API 幻觉。缺失: ${missing.join(', ')}`,
      };
    }

    case 'trigger_self_evaluation': {
      const writtenFiles = (args.written_files as string[]) || [];
      const usedSkills = (args.used_skills as string[]) || [];
      const checks = [
        '🔍 占位符检查：确认代码中无 YOUR_URL、YOUR_TOKEN 等假值',
        '🔍 API 签名检查：确认所有 API 调用参数与 Skill 文档一致',
        '🔍 生命周期检查：确认初始化 → 渲染 → 清理的完整链路',
        '🔍 初始化顺序检查：Plugin.Install 在 Renderer.Start 之前',
        '🔍 工程基线检查：确认使用 npm install wdpapi（非 CDN）',
        '🔍 Skill 签名一致性检查：确认所有 API 调用（方法名、参数名、参数类型）与已读 Skill 文件完全一致，禁止凭记忆编造 API',
        '🔍 上下文持久化检查：确认已调用 write_context_state 保存关键业务参数（URL、Token、模型ID、坐标等），确保跨轮对话不丢失',
      ];
      return {
        written_files: writtenFiles,
        used_skills: usedSkills,
        checks,
        hint: '请逐项检查以上 7 项，发现问题立即修正。禁止凭记忆编造任何 WDP API 调用。务必确认上下文已保存。',
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
  const builtinFiles = ['wdp-context-memory.md', 'wdp-intent-orchestrator.md'];
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