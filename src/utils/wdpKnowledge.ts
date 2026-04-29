import fs from 'fs';
import path from 'path';
import { generateDigest, computeFileHash, SkillDigest, DigestWithHash, digestToText } from './digestGenerator';

export { generateDigest, computeFileHash, SkillDigest, DigestWithHash, digestToText };

export type SearchResultKind = 'skill' | 'official' | 'resource' | 'template' | 'file';
export type WorkflowMode = 'ready' | 'clarify' | 'blocked';
export type QueryMode = 'direct' | 'search' | 'clarify' | 'blocked';

export interface SearchResult {
  path: string;
  preview: string;
  score: number;
  kind: SearchResultKind;
  matchedBy: string[];
}

export interface RouteMatch {
  label: string;
  skillPath: string;
  officialFiles: string[];
  score: number;
  matchedKeywords: string[];
}

export interface MandatoryCheckpoint {
  name: string;
  tool: string;
  trigger: string;
  blockOnFailure: boolean;
  params?: Record<string, unknown>;
}

export interface WorkflowResponse {
  success: true;
  title: string;
  mode: WorkflowMode;
  confidence: number;
  userRequirement: string;
  projectPath: string;
  matchedDomains: string[];
  matchedSkills: string[];
  requiredOfficialFiles: string[];
  expandedQueries: string[];
  missingRequiredParams: string[];
  clarifyingQuestions: string[];
  canGenerateCode: boolean;
  guidance: string;
  workflowSteps: Array<Record<string, unknown>>;
  importantNotes: string[];
  nextAction: string;
  timestamp: string;
  mandatoryCheckpoints: MandatoryCheckpoint[];
  constraintViolationMessage: string;
}

export interface QueryResponse {
  success: true;
  mode: QueryMode;
  type: 'direct' | 'search';
  query: string;
  confidence: number;
  canGenerateCode: boolean;
  skillPath?: string;
  path?: string;
  content?: string;
  results?: SearchResult[];
  resultCount: number;
  matchedSkills: string[];
  requiredOfficialFiles: string[];
  expandedQueries: string[];
  clarifyingQuestions: string[];
  guidance: string;
  evidence: string[];
  timestamp: string;
}

interface SkillRouteConfig {
  label: string;
  skillPath: string;
  officialFiles: string[];
  keywords: string[];
  scenarios: string[];
}

interface MpcToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, object>;
    required?: string[];
  };
}

const MAX_SEARCH_RESULTS = 12;
const SEARCHABLE_EXTENSIONS = new Set(['.md', '.json', '.js', '.html']);
const DIRECT_CODE_SAFE_PATHS = new Set([
  'official_api_code_example/official-bim-full.md',
  'official_api_code_example/official-cluster.md',
  // coverings 拆分后
  'official_api_code_example/official-entity-coverings-spatial.md',
  'official_api_code_example/official-entity-coverings-path.md',
  'official_api_code_example/official-entity-coverings-effects.md',
  // behavior 拆分后
  'official_api_code_example/official-entity-general-behavior-core.md',
  'official_api_code_example/official-entity-general-behavior-interaction.md',
  'official_api_code_example/official-entity-general-behavior-movement.md',
  'official_api_code_example/official-function-components.md',
  'official_api_code_example/official-general-event-registration.md',
  'official_api_code_example/official-generic-base-attributes.md',
  'official_api_code_example/official-gis-full.md',
  'official_api_code_example/official-initialize-scene.md',
  'official_api_code_example/official-layer-models.md',
  'official_api_code_example/official-material-settings.md',
  'official_api_code_example/official-scene-camera.md',
  'official_api_code_example/official-spatial-understanding.md',
]);

const QUERY_ALIAS_GROUPS: Array<{ triggers: string[]; expansions: string[] }> = [
  {
    triggers: ['大楼', '楼宇', '建筑', '楼体', '园区', '模型展示'],
    expansions: ['bim', '模型', '构件', '建筑信息模型', '场景初始化'],
  },
  {
    triggers: ['地图', '底图', '地理', '地理信息', '经纬度', 'geojson', 'wms', 'wmts', '3dtiles'],
    expansions: ['gis', '图层', '地理信息', '坐标转换', 'GeoLayer'],
  },
  {
    triggers: ['漫游', '飞行', '视角', '镜头', '相机', '跟随', '聚焦'],
    expansions: ['camera', '相机控制', '视角控制', 'scene camera'],
  },
  {
    triggers: ['点击', '悬停', '事件', '回调', '监听'],
    expansions: ['事件注册', '交互回调', 'scene event'],
  },
  {
    triggers: ['高亮', '描边', '材质', '换色', '房间高亮'],
    expansions: ['材质设置', '实体行为', 'bim', 'material'],
  },
  {
    triggers: ['poi', '标注', '弹窗', '窗口', '视频融合', '热力图', '路径', '围栏'],
    expansions: ['覆盖物', 'window', 'poi', 'coverings'],
  },
  {
    triggers: ['点位', '聚合', '周边搜索', '海量点'],
    expansions: ['cluster', '点聚合', '周边搜索'],
  },
  {
    triggers: ['坐标', '取点', '定位', '空间', '经纬度转屏幕'],
    expansions: ['空间理解', '坐标转换', 'spatial understanding'],
  },
  {
    triggers: ['初始化', '接入', '启动', '不显示', '白屏', 'sdk', '渲染'],
    expansions: ['初始化', 'Renderer.Start', 'new WdpApi', '场景初始化'],
  },
  {
    triggers: ['css', '层级', '遮挡', 'pointer-events', 'z-index', '弹层'],
    expansions: ['CSS层叠管理', 'z-index', 'pointer-events'],
  },
];

const SKILL_ROUTE_CONFIGS: SkillRouteConfig[] = [
  {
    label: 'BIM模型操作',
    skillPath: 'wdp-api-bim-unified/SKILL.md',
    officialFiles: ['official_api_code_example/official-bim-full.md'],
    keywords: ['bim', '构件', '房间', '楼层', '建筑', '大楼', '模型', '园区', '楼宇', '空间'],
    scenarios: ['BIM模型操作、构件高亮、房间高亮'],
  },
  {
    label: 'GIS核心操作',
    skillPath: 'gis-api-core-operations/SKILL.md',
    officialFiles: ['official_api_code_example/official-gis-full.md'],
    keywords: ['gis', '地图', '地理', 'geojson', 'wms', 'wmts', '3dtiles', '图层', '经纬度'],
    scenarios: ['GIS核心操作、地图、地理信息'],
  },
  {
    label: '相机控制',
    skillPath: 'wdp-api-camera-unified/SKILL.md',
    officialFiles: ['official_api_code_example/official-scene-camera.md'],
    keywords: ['相机', '视角', '漫游', '飞行', '镜头', '聚焦', '跟随', 'camera'],
    scenarios: ['相机控制、视角漫游、相机位置'],
  },
  {
    label: '事件注册交互',
    skillPath: 'wdp-api-general-event-registration/SKILL.md',
    officialFiles: ['official_api_code_example/official-general-event-registration.md'],
    keywords: ['事件', '点击', '悬停', '监听', '回调', 'sceneevent', '注册'],
    scenarios: ['事件注册、事件监听、交互回调'],
  },
  {
    label: '实体通用行为',
    skillPath: 'wdp-api-entity-general-behavior/SKILL.md',
    officialFiles: [
      'official_api_code_example/official-entity-general-behavior-core.md',
      'official_api_code_example/official-entity-general-behavior-interaction.md',
      'official_api_code_example/official-entity-general-behavior-movement.md',
    ],
    keywords: [
      // 核心查询与管理
      '实体', '显隐', '删除', '检索', '查询', 'getby', 'clearby',
      'setvisible', 'focus', 'eid', 'entityname', 'customid', 'type',
      // 交互与编辑
      '描边', '高亮', 'outline', 'highlight', '选中', 'selection',
      '拾取', 'picker', '修改', 'modify', '裁剪', 'clip',
      // 移动与批量
      '移动', 'bound', '沿路径运动', '批量', 'scene.create', 'scene.creates',
      '落地', 'snapto',
      // 通用
      'entity',
    ],
    scenarios: [
      '实体查询与管理（GetByXxx/Clear/SetVisible/Focus）',
      '实体交互与编辑（Picker/Selection/Outline/Highlight/Modify/Clip）',
      '实体移动与批量操作（Bound/Scene.Create/Creates）',
    ],
  },
  {
    label: '覆盖物管理',
    skillPath: 'wdp-api-coverings-unified/SKILL.md',
    officialFiles: [
      'official_api_code_example/official-entity-coverings-spatial.md',
      'official_api_code_example/official-entity-coverings-path.md',
      'official_api_code_example/official-entity-coverings-effects.md',
    ],
    keywords: [
      // 空间标注类
      'poi', '覆盖物', '标注', '弹窗', 'window', '范围', 'range',
      '文字', 'text3d', '实时视频', 'video', '自定义poi', 'custompoi',
      '组', 'group', '层级', 'hierarchy', '项目实例', 'projectinstance',
      '建模', 'modeler', 'fence', 'water', 'river', 'floor', 'embank',
      // 路径运动类
      '路径', 'path', '迁徙图', 'parabola', '粒子', 'particle',
      // 数据可视化与特效类
      '热力图', 'heatmap', '柱状热力图', 'columnarheatmap', 'spaceheatmap',
      'roadheatmap', 'meshheatmap', '特效', 'effects', '灯光', 'light',
      '可视域', 'viewshed', '栅格', 'raster', '高亮区域', 'highlightarea',
      // 通用
      '围栏', '视频',
    ],
    scenarios: [
      '空间标注与交互覆盖物（POI/Window/Range/Text3D/Video）',
      '路径与运动覆盖物（Path/Particle/Parabola）',
      '数据可视化与特效覆盖物（HeatMap/Effects/Light/Viewshed）',
    ],
  },
  {
    label: '图层模型Tiles',
    skillPath: 'wdp-api-layer-models/SKILL.md',
    officialFiles: ['official_api_code_example/official-layer-models.md'],
    keywords: ['图层', 'tiles', '模型摆放', '底板', 'aes', '节点分组', '3dtiles'],
    scenarios: ['图层模型、Tiles、AES底板'],
  },
  {
    label: '场景初始化',
    skillPath: 'wdp-api-initialization-unified/SKILL.md',
    officialFiles: ['official_api_code_example/official-initialize-scene.md'],
    keywords: ['初始化', '启动', '接入', '白屏', '渲染', 'renderer.start', 'new wdpapi', 'sdk', '智能建模系列', '静态实例模型', '建模', '静态', '实例'],
    scenarios: ['场景初始化、渲染器启动、智能建模系列、静态实例模型'],
  },
  {
    label: '点聚合Cluster',
    skillPath: 'wdp-api-cluster/SKILL.md',
    officialFiles: ['official_api_code_example/official-cluster.md'],
    keywords: ['聚合', 'cluster', '周边搜索', '海量点', '点位聚合'],
    scenarios: ['点聚合Cluster、数据聚合、周边搜索'],
  },
  {
    label: '功能组件特效',
    skillPath: 'wdp-api-function-components/SKILL.md',
    officialFiles: ['official_api_code_example/official-function-components.md'],
    keywords: ['天气', '水面', '天空盒', '粒子', '后处理', '工具', '控件', '拾取'],
    scenarios: ['功能组件、天气、水面、天空盒、粒子特效、后处理'],
  },
  {
    label: '实体属性操作',
    skillPath: 'wdp-api-generic-base-attributes/SKILL.md',
    officialFiles: ['official_api_code_example/official-generic-base-attributes.md'],
    keywords: ['属性', 'get()', 'eid', 'nodeid', '属性读写', '批量更新', '代理对象'],
    scenarios: ['实体属性、属性读写、批量更新'],
  },
  {
    label: '材质设置高亮',
    skillPath: 'wdp-api-material-settings/SKILL.md',
    officialFiles: ['official_api_code_example/official-material-settings.md'],
    keywords: ['材质', '高亮', '换色', '高亮材质', '模型高亮', 'material'],
    scenarios: ['材质设置、材质替换、材质高亮、模型高亮'],
  },
  {
    label: '空间理解坐标转换',
    skillPath: 'wdp-api-spatial-understanding/SKILL.md',
    officialFiles: ['official_api_code_example/official-spatial-understanding.md'],
    keywords: ['坐标', '空间理解', '取点', '屏幕坐标', '经纬度转换', '定位', 'spatial'],
    scenarios: ['空间理解、坐标转换、取点交互、GIS坐标'],
  },
  {
    label: '场景要素发现',
    skillPath: 'wdp-api-scene-discovery/SKILL.md',
    officialFiles: [
      'official_api_code_example/official-function-components.md',
      'official_api_code_example/official-entity-general-behavior-core.md',
      'official_api_code_example/official-scene-camera.md',
      'official_api_code_example/official-bim-full.md',
      'official_api_code_example/official-spatial-understanding.md',
    ],
    keywords: [
      '发现', '拾取', '查询实体', '列出', '遍历', '场景检查',
      '有什么', '哪些', '检查场景', '获取实体', '场景快照',
      'discovery', 'inspect', 'list entities', 'picker', 'find',
      '不知道id', '不知道有哪些', '场景要素', '对象查询',
    ],
    scenarios: [
      '场景要素发现、实体枚举、屏幕拾取获取ID、BIM层级遍历、相机预设查询、坐标取点',
    ],
  },
];

const SKILL_MAPPING = Object.fromEntries(
  SKILL_ROUTE_CONFIGS.map((route) => [route.label, route.skillPath]),
);

const SKILL_EXAMPLES = SKILL_ROUTE_CONFIGS.flatMap((route) =>
  route.scenarios.map((scenario) => ({
    scenario,
    path: route.skillPath,
  })),
);

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pathToPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function classifyPath(filePath: string): SearchResultKind {
  if (filePath.includes('official_api_code_example/official-')) {
    return 'official';
  }
  if (filePath.endsWith('SKILL.md')) {
    return 'skill';
  }
  if (filePath.includes('/resources/') || filePath.endsWith('.json')) {
    return 'resource';
  }
  if (filePath.includes('.template.')) {
    return 'template';
  }
  return 'file';
}

function resultKindPriority(kind: SearchResultKind): number {
  switch (kind) {
    case 'official':
      return 4;
    case 'skill':
      return 3;
    case 'template':
      return 2;
    case 'resource':
      return 1;
    default:
      return 0;
  }
}

function buildPreview(content: string, matchedBy: string[]): string {
  const lowerContent = normalizeText(content);
  const match = matchedBy.find((item) => lowerContent.includes(normalizeText(item)));
  if (!match) {
    return content.slice(0, 220).replace(/\s+/g, ' ').trim();
  }

  const index = lowerContent.indexOf(normalizeText(match));
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + 140);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function includesAny(text: string, values: string[]): string[] {
  return values.filter((item) => text.includes(normalizeText(item)));
}

function inferMissingParams(query: string): string[] {
  const lowerQuery = normalizeText(query);
  const missing: string[] = [];

  if (!/https?:\/\//i.test(query) && !lowerQuery.includes('url')) {
    missing.push('url');
  }

  if (!/\b[a-f0-9]{32}\b/i.test(query) && !lowerQuery.includes('order') && !lowerQuery.includes('口令')) {
    missing.push('order');
  }

  if (
    ['高亮', '构件', '房间', '定位', '飞到', '聚焦', '查看实体'].some((keyword) => lowerQuery.includes(normalizeText(keyword))) &&
    !['eid', 'uid', 'entityid', 'entity id', '实体id', '构件id', '房间id', '名称', 'name', 'nodeid'].some((keyword) =>
      lowerQuery.includes(normalizeText(keyword)),
    )
  ) {
    missing.push('target');
  }

  if (
    ['poi', '标注', '点位', '经纬度', '热力图', '路径', '围栏', '地图', 'geojson'].some((keyword) =>
      lowerQuery.includes(normalizeText(keyword)),
    ) &&
    !['坐标', '经纬度', 'geojson', '数据', '点位数据', 'lat', 'lng', 'longitude', 'latitude'].some((keyword) =>
      lowerQuery.includes(normalizeText(keyword)),
    )
  ) {
    missing.push('data');
  }

  return missing;
}

function buildClarifyingQuestions(query: string, matchedRoutes: RouteMatch[], missingParams: string[]): string[] {
  const questions: string[] = [];
  const normalizedQuery = normalizeText(query);
  const mentionsObjectOperation = [
    '高亮',
    '构件',
    '房间',
    '定位',
    '飞到',
    '聚焦',
    '实体',
    '模型',
    'poi',
    'window',
    '粒子',
    '特效',
    'path',
    'gis要素',
    'feature',
  ].some((keyword) => normalizedQuery.includes(normalizeText(keyword)));
  const mentionsObjectCategory = [
    'hierarchy',
    'path',
    'poi',
    'window',
    'particle',
    'effects',
    'bim构件',
    'gis要素',
  ].some((keyword) => normalizedQuery.includes(normalizeText(keyword)));
  const mentionsObjectId = [
    'eid',
    'entityname',
    'customid',
    'seedid',
    'nodeid',
    'featureid',
  ].some((keyword) => normalizedQuery.includes(keyword));

  if (missingParams.includes('url')) {
    questions.push('请提供 WDP 服务 URL，不能使用 YOUR_URL 这类占位符。');
  }
  if (missingParams.includes('order')) {
    questions.push('请提供与该环境匹配的 Order 或验证口令。');
  }
  if (missingParams.includes('target')) {
    questions.push(
      '请先明确目标对象信息：至少补充 eid、entityName、customId、seedId、nodeId 或 featureId 中的一种有效标识。',
    );
  }
  if (missingParams.includes('data')) {
    questions.push('请补充业务数据，例如坐标、GeoJSON、点位列表或窗口内容。');
  }
  if (mentionsObjectOperation && !mentionsObjectCategory) {
    questions.push(
      '当前涉及对象操作，请先明确对象类别：Hierarchy、Path、Poi、Window、Particle、Effects、BIM构件 或 GIS要素。',
    );
  }
  if (mentionsObjectOperation && !mentionsObjectId) {
    questions.push(
      '如果你现在还没有准确对象 Id，请说明准备通过创建返回值、屏幕拾取、事件回调、实体查询、BIM 查询还是 GIS 查询来获取。',
    );
  }

  if (matchedRoutes.length === 0) {
    questions.push('这是 BIM、GIS、覆盖物、相机控制还是事件交互场景？请明确主域。');
  } else if (matchedRoutes.length > 1 && matchedRoutes[0].score === matchedRoutes[1].score) {
    questions.push(`当前同时命中了 ${matchedRoutes[0].label} 和 ${matchedRoutes[1].label}，请确认主需求偏向哪一个。`);
  }

  if (!normalizedQuery.includes('从零') && !normalizedQuery.includes('现有代码')) {
    questions.push('这是在现有页面上接功能，还是需要从零搭建一个新的 WDP 页面？');
  }

  return unique(questions).slice(0, 4);
}

function calculateConfidence(matchedRoutes: RouteMatch[], searchResultsCount = 0): number {
  if (matchedRoutes.length === 0) {
    return searchResultsCount > 0 ? 0.42 : 0.24;
  }

  const topScore = matchedRoutes[0].score;
  const secondScore = matchedRoutes[1]?.score ?? 0;
  let confidence = 0.35 + topScore * 0.12 + Math.min(secondScore, 2) * 0.05;

  if (matchedRoutes.length > 1 && topScore === secondScore) {
    confidence -= 0.12;
  }

  if (searchResultsCount > 0) {
    confidence += 0.05;
  }

  return Number(clamp(confidence, 0.2, 0.94).toFixed(2));
}

export function expandQuery(query: string): string[] {
  const expansions = [query.trim()];
  const lowerQuery = normalizeText(query);

  for (const group of QUERY_ALIAS_GROUPS) {
    if (group.triggers.some((trigger) => lowerQuery.includes(normalizeText(trigger)))) {
      expansions.push(...group.expansions);
    }
  }

  return unique(expansions.filter(Boolean));
}

export function inferRouteMatches(query: string): RouteMatch[] {
  const lowerQuery = normalizeText(query);
  const expandedQueries = expandQuery(query).map((item) => normalizeText(item));

  return SKILL_ROUTE_CONFIGS
    .map((route) => {
      const matchedKeywords = unique([
        ...includesAny(lowerQuery, route.keywords),
        ...expandedQueries.flatMap((expanded) => includesAny(expanded, route.keywords)),
      ]);

      return {
        label: route.label,
        skillPath: route.skillPath,
        officialFiles: route.officialFiles,
        score: matchedKeywords.length,
        matchedKeywords,
      };
    })
    .filter((route) => route.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function readKnowledgeFile(knowledgeBasePath: string, skillPath: string): string | null {
  const fullPath = path.resolve(knowledgeBasePath, skillPath);

  if (!fullPath.startsWith(knowledgeBasePath)) {
    return null;
  }

  try {
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    return null;
  } catch (error) {
    console.error('读取文件失败:', error);
    return null;
  }
}

export function searchKnowledgeBase(knowledgeBasePath: string, query: string, maxResults = MAX_SEARCH_RESULTS): SearchResult[] {
  const expandedQueries = expandQuery(query);
  const resultMap = new Map<string, SearchResult>();

  const searchDir = (dir: string, basePath = ''): void => {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const relativePath = pathToPosix(path.join(basePath, item));
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        searchDir(fullPath, relativePath);
        continue;
      }

      const extension = path.extname(item).toLowerCase();
      // 支持 universal-bootstrap.template.package.json 这类模板文件
      const isTemplatePackageJson = item.includes('.template.') && item.endsWith('.package.json');
      if (!SEARCHABLE_EXTENSIONS.has(extension) && item !== 'package.json' && !isTemplatePackageJson) {
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lowerContent = normalizeText(content);
      const lowerPath = normalizeText(relativePath);
      const matchedBy: string[] = [];
      let score = 0;

      for (const term of expandedQueries) {
        const lowerTerm = normalizeText(term);
        if (!lowerTerm) {
          continue;
        }

        if (lowerPath.includes(lowerTerm)) {
          score += 5;
          matchedBy.push(term);
          continue;
        }

        if (lowerContent.includes(lowerTerm)) {
          score += 2;
          matchedBy.push(term);
        }
      }

      if (score === 0) {
        continue;
      }

      const kind = classifyPath(relativePath);
      const existing = resultMap.get(relativePath);
      const nextResult: SearchResult = {
        path: relativePath,
        preview: buildPreview(content, matchedBy),
        score: score + resultKindPriority(kind),
        kind,
        matchedBy: unique(matchedBy),
      };

      if (!existing || nextResult.score > existing.score) {
        resultMap.set(relativePath, nextResult);
      }
    }
  };

  try {
    if (fs.existsSync(knowledgeBasePath)) {
      searchDir(knowledgeBasePath);
    }
  } catch (error) {
    console.error('搜索失败:', error);
  }

  return Array.from(resultMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

export function listKnowledgeEntries(
  knowledgeBasePath: string,
  options: { includeReferences?: boolean } = {},
): any[] {
  const { includeReferences = false } = options;

  const listDir = (dir: string, basePath = ''): any[] => {
    const items: any[] = [];

    try {
      if (!fs.existsSync(dir)) {
        return items;
      }

      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relativePath = pathToPosix(path.join(basePath, entry));
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          const children = listDir(fullPath, relativePath);
          const hasSkill = fs.existsSync(path.join(fullPath, 'SKILL.md'));

          items.push({
            name: entry,
            path: relativePath,
            type: 'directory',
            isSkill: hasSkill,
            children: children.length > 0 ? children : undefined,
          });
          continue;
        }

        const extension = path.extname(entry).toLowerCase();
        // 支持 universal-bootstrap.template.* 模板文件
        const isTemplateFile = entry.includes('.template.');
        const shouldInclude = includeReferences
          ? SEARCHABLE_EXTENSIONS.has(extension) || entry === 'package.json' || isTemplateFile
          : extension === '.md' || isTemplateFile;

        if (!shouldInclude) {
          continue;
        }

        items.push({
          name: entry,
          path: relativePath,
          type: classifyPath(relativePath),
        });
      }
    } catch (error) {
      console.error('列出技能失败:', error);
    }

    return items;
  };

  return listDir(knowledgeBasePath);
}

export function buildWorkflowResponse(userRequirement: string, projectPath?: string): WorkflowResponse {
  const expandedQueries = expandQuery(userRequirement);
  const matchedRoutes = inferRouteMatches(userRequirement);
  const missingRequiredParams = inferMissingParams(userRequirement);
  const requiredOfficialFiles = unique(matchedRoutes.flatMap((route) => route.officialFiles));
  const clarifyingQuestions = buildClarifyingQuestions(userRequirement, matchedRoutes, missingRequiredParams);
  const confidence = calculateConfidence(matchedRoutes);
  const mode: WorkflowMode = missingRequiredParams.length > 0 || confidence < 0.72 ? 'clarify' : 'ready';
  const isLongTask = matchedRoutes.length > 1 || requiredOfficialFiles.length > 1;

  // 构建强制检查点
  const mandatoryCheckpoints: MandatoryCheckpoint[] = [
    {
      name: 'project_scaffolding_check',
      tool: 'enforce_project_scaffolding_valid',
      trigger: '第一轮编码/生成基础框架前',
      blockOnFailure: true,
      params: { description: "验证当前项目目录是否存在 package.json 且依赖了 wdpapi。如果尝试使用 html <script> 引入而不使用前端构建工具，直接阻断代码生成。" }
    },
    {
      name: 'routing_check',
      tool: 'enforce_routing_check',
      trigger: '编码前',
      blockOnFailure: true,
    },
    {
      name: 'official_docs_check',
      tool: 'enforce_official_docs_read',
      trigger: '编码前',
      blockOnFailure: true,
      params: { required_files: requiredOfficialFiles },
    },
    {
      name: 'object_ids_check',
      tool: 'enforce_object_ids_valid',
      trigger: '涉及对象操作时',
      blockOnFailure: true,
    },
    {
      name: 'code_evaluation',
      tool: 'trigger_self_evaluation',
      trigger: '代码编写完成后，向用户汇报前',
      blockOnFailure: true,
    },
  ];

  // 【硬编码】强制工作目录声明
  const workingDirectoryHint = projectPath 
    ? `\n\n【⚠️ 强制工作目录约束】\n你的工程路径是: ${projectPath}\n所有文件操作（创建、修改、安装依赖）必须在此路径下进行！禁止在当前工作目录或其他位置创建文件。`
    : '';

  return {
    success: true,
    title: 'WDP 开发工作流启动',
    mode,
    confidence,
    userRequirement,
    projectPath: projectPath || '未指定',
    matchedDomains: matchedRoutes.map((route) => route.label),
    matchedSkills: matchedRoutes.map((route) => route.skillPath),
    requiredOfficialFiles,
    expandedQueries,
    missingRequiredParams,
    clarifyingQuestions,
    canGenerateCode: mode === 'ready' && requiredOfficialFiles.length > 0,
    guidance:
      mode === 'ready'
        ? `已命中 WDP 路由。【关键】编码前必须依次调用 mandatoryCheckpoints 中的检查工具。如果检查未通过，禁止生成代码。${workingDirectoryHint}`
        : `当前仍需补充信息或读取 official 文档。未确认到真值前，不要自行编排 WDP 方法名和参数名。${workingDirectoryHint}`,
    workflowSteps: [
      {
        step: 1,
        name: '入口路由判断',
        action: '读取 wdp-entry-agent/SKILL.md',
        toolCall: { tool: 'get_skill_content', path: 'wdp-entry-agent/SKILL.md' },
      },
      {
        step: 2,
        name: '意图编排与需求分析',
        action: '读取 wdp-intent-orchestrator/SKILL.md',
        toolCall: { tool: 'get_skill_content', path: 'wdp-intent-orchestrator/SKILL.md' },
      },
      {
        step: 3,
        name: '初始化基线',
        action: '读取场景初始化与骨架模板',
        toolCalls: [
          { tool: 'get_skill_content', path: 'wdp-api-initialization-unified/SKILL.md' },
          { tool: 'get_skill_content', path: 'official_api_code_example/universal-bootstrap.template.html' },
          { tool: 'get_skill_content', path: 'official_api_code_example/universal-bootstrap.template.main.js' },
          { tool: 'get_skill_content', path: 'official_api_code_example/universal-bootstrap.template.package.json' },
        ],
      },
      {
        step: 4,
        name: '技能路由与真值确认',
        action: '根据命中的技能读取 sub skill，并继续读取 official 文档确认 API 真值（模板文件必须强制读取）',
        skillMapping: SKILL_MAPPING,
        matchedSkills: matchedRoutes.map((route) => ({
          label: route.label,
          path: route.skillPath,
          officialFiles: route.officialFiles,
          matchedKeywords: route.matchedKeywords,
        })),
        examples: SKILL_EXAMPLES,
      },
      {
        step: 5,
        name: '代码生成门禁',
        action: '只有在已读取对应 official 文档、核心参数齐全时，才允许生成代码',
        requiredOfficialFiles,
        checklist: [
          '已确认 WDP 服务 URL，不使用占位符',
          '已确认 Order 或验证口令',
          '已读取命中的 official-*.md 文档',
          '已读取所有相关的 universal-bootstrap.template 模板文件',
          '已确认前端基于 package.json 进行工程化构建',
          '已确认插件安装顺序在 Renderer.Start 之前',
          '已准备开启与关闭两条清理路径',
        ],
      },
    ],
    importantNotes: [
      '严禁使用 YOUR_URL 等假值，缺失时必须先追问用户。',
      'Sub skill 负责路由与能力说明，official-*.md 才是 API 方法名、参数名和代码示例的唯一真值。',
      '在命中 official 文档之前，不要根据通识经验猜测 WDP 方法名或参数名。',
      '如果场景涉及 BIM 或 GIS，请先确认 Plugin.Install 的安装链路。',
    ],
    nextAction:
      mode === 'ready'
        ? '请先读取命中的 official 文档，再生成代码。'
        : '请先向用户补充缺失信息，或缩小到明确的 WDP 技能域后再继续。',
    timestamp: new Date().toISOString(),
    mandatoryCheckpoints,
    constraintViolationMessage: '约束检查未通过。请先完成 mandatoryCheckpoints 中的所有检查，再继续生成代码。',
  };
}

function buildDirectQueryResponse(query: string, skillPath: string, content: string): QueryResponse {
  const matchedRoutes = inferRouteMatches(`${query} ${skillPath}`);
  const missingRequiredParams = inferMissingParams(query);
  const requiredOfficialFiles = unique([
    ...matchedRoutes.flatMap((route) => route.officialFiles),
    ...(DIRECT_CODE_SAFE_PATHS.has(skillPath) ? [skillPath] : []),
  ]);
  const canGenerateCode = DIRECT_CODE_SAFE_PATHS.has(skillPath) && missingRequiredParams.length === 0;

  return {
    success: true,
    mode: canGenerateCode ? 'direct' : 'search',
    type: 'direct',
    query,
    confidence: canGenerateCode ? 0.92 : 0.82,
    canGenerateCode,
    skillPath,
    path: skillPath,
    content,
    resultCount: 1,
    matchedSkills: matchedRoutes.map((route) => route.skillPath),
    requiredOfficialFiles,
    expandedQueries: expandQuery(query),
    clarifyingQuestions: buildClarifyingQuestions(query, matchedRoutes, missingRequiredParams),
    guidance: canGenerateCode
      ? '已直接读取 official 真值文件，若核心参数齐全，可继续生成代码。'
      : '已找到目标文档，但仍需补齐参数或继续读取对应 official 文档后再生成代码。',
    evidence: [skillPath],
    timestamp: new Date().toISOString(),
  };
}

export function buildKnowledgeQueryResponse(
  knowledgeBasePath: string,
  query: string,
  skillPath?: string,
): QueryResponse {
  if (skillPath) {
    const content = readKnowledgeFile(knowledgeBasePath, skillPath);
    if (content) {
      return buildDirectQueryResponse(query, skillPath, content);
    }
  }

  const results = searchKnowledgeBase(knowledgeBasePath, query);
  const matchedRoutes = inferRouteMatches(query);
  const missingRequiredParams = inferMissingParams(query);
  const requiredOfficialFiles = unique([
    ...matchedRoutes.flatMap((route) => route.officialFiles),
    ...results.filter((result) => result.kind === 'official').map((result) => result.path),
  ]);
  const confidence = calculateConfidence(matchedRoutes, results.length);
  const clarifyingQuestions = buildClarifyingQuestions(query, matchedRoutes, missingRequiredParams);
  const mode: QueryMode =
    results.length === 0 || missingRequiredParams.length > 0 || confidence < 0.72 ? 'clarify' : 'search';

  return {
    success: true,
    mode,
    type: 'search',
    query,
    confidence,
    canGenerateCode: false,
    results,
    resultCount: results.length,
    matchedSkills: unique([
      ...matchedRoutes.map((route) => route.skillPath),
      ...results.filter((result) => result.kind === 'skill').map((result) => result.path),
    ]),
    requiredOfficialFiles,
    expandedQueries: expandQuery(query),
    clarifyingQuestions,
    guidance:
      mode === 'clarify'
        ? '当前证据不足。请先补充信息，并读取候选 official 文档，再继续 WDP 代码生成。'
        : '已命中相关知识，请先读取列出的 official 文档确认 API 真值。',
    evidence: results.map((result) => result.path),
    timestamp: new Date().toISOString(),
  };
}

// ============ 约束检查函数 ============

export interface ConstraintCheckResult {
  passed: boolean;
  block: boolean;
  message?: string;
  action?: string;
  missingItems?: string[];
}

/**
 * 强制检查：路由确认
 * 验证是否已通过 start_wdp_workflow 获取路由并读取必要 skill
 */
export function enforceRoutingCheck(
  workflowResult: WorkflowResponse,
  skillsRead: string[]
): ConstraintCheckResult {
  const requiredSkills = workflowResult.matchedSkills || [];
  const missingSkills = requiredSkills.filter(
    (skill) => !skillsRead.some((read) => read.includes(skill.replace('/SKILL.md', '')))
  );

  if (missingSkills.length > 0) {
    return {
      passed: false,
      block: true,
      message: `未读取必要 skill: ${missingSkills.join(', ')}`,
      action: `请先调用 get_skill_content 读取: ${missingSkills.join(', ')}`,
      missingItems: missingSkills,
    };
  }

  return { passed: true, block: false };
}

/**
 * 强制检查：official 文档读取
 * 验证 requiredOfficialFiles 是否已读取
 */
export function enforceOfficialDocsRead(
  requiredFiles: string[],
  filesRead: string[]
): ConstraintCheckResult {
  const missingFiles = requiredFiles.filter(
    (file) => !filesRead.some((read) => read.includes(file))
  );

  if (missingFiles.length > 0) {
    return {
      passed: false,
      block: true,
      message: `未读取 official 真值文档: ${missingFiles.join(', ')}`,
      action: `请先调用 get_skill_content 读取 official 文档，禁止基于经验猜测 API 方法名和参数名`,
      missingItems: missingFiles,
    };
  }

  return { passed: true, block: false };
}

/**
 * 强制检查：context-memory 启用
 * 长任务必须启用状态管理
 */
export function enforceContextMemoryEnabled(
  dialogueRounds: number,
  skillsCount: number,
  memoryEnabled: boolean
): ConstraintCheckResult {
  const isLongTask = dialogueRounds >= 1 || skillsCount > 0;

  if (isLongTask && !memoryEnabled) {
    return {
      passed: false,
      block: true,
      message: `长流程任务必须启用 wdp-context-memory 状态管理`,
      action: `请先调用 get_skill_content 读取 wdp-context-memory/SKILL.md 并启用状态管理`,
      missingItems: ['wdp-context-memory'],
    };
  }

  return { passed: true, block: false };
}

/**
 * 强制检查：对象 Id 有效性
 * 验证代码中使用的对象 Id 不是假值
 */
export function enforceObjectIdsValid(
  objectIds: Array<{ name: string; value: string; source?: string }>,
  allowMock: boolean = false
): ConstraintCheckResult {
  const invalidIds = objectIds.filter((id) => {
    const val = id.value;
    // 检查假值模式
    const isMockValue =
      val.includes('YOUR_') ||
      val.includes('TODO') ||
      val.includes('FIXME') ||
      val.includes('placeholder') ||
      val.includes('xxx') ||
      val.includes('123') ||
      val.length < 3;
    return isMockValue;
  });

  if (invalidIds.length > 0 && !allowMock) {
    return {
      passed: false,
      block: true,
      message: `发现无效对象 Id: ${invalidIds.map((i) => i.name).join(', ')}`,
      action: `请通过创建返回值、屏幕拾取、事件回调、实体查询、BIM 查询或 GIS 查询获取真实 Id，禁止使用假值`,
      missingItems: invalidIds.map((i) => i.name),
    };
  }

  return { passed: true, block: false };
}

/**
 * 强制检查：工程初始化基线检查
 * 验证工程目录下是否有 package.json 及其依赖
 */
export function enforceProjectScaffoldingValid(
  projectPath: string
): ConstraintCheckResult {
  if (!projectPath) {
    return {
      passed: false,
      block: true,
      message: `必须提供目标工程根目录 (projectPath)`,
      action: `请重新调用 enforce_project_scaffolding_valid 并提供正确的 projectPath`,
    };
  }

  const pkgJsonPath = path.join(projectPath, 'package.json');
  
  if (!fs.existsSync(pkgJsonPath)) {
    return {
      passed: false,
      block: true,
      message: `在工程根目录 ${projectPath} 下未找到 package.json`,
      action: `【架构铁律】禁止直接使用 <script> 引入 wdpapi！请使用前端构建工具 (如 Vite/Webpack) 初始化工程，并运行 npm init 创建 package.json。`,
    };
  }

  try {
    const pkgContent = fs.readFileSync(pkgJsonPath, 'utf-8');
    const pkg = JSON.parse(pkgContent);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    
    if (!deps['wdpapi']) {
      return {
        passed: false,
        block: true,
        message: `在 package.json 中未找到 wdpapi 依赖`,
        action: `【架构铁律】必须采用 npm 工程化基线！请在 package.json 中添加 "wdpapi" 依赖，并执行 npm install。`,
      };
    }

    // BIM 和 GIS 插件依赖检查
    const missingPlugins: string[] = [];
    if (projectPath.toLowerCase().includes('bim') || JSON.stringify(deps).toLowerCase().includes('bim')) {
      if (!deps['@wdp-api/bim-api']) missingPlugins.push('@wdp-api/bim-api');
    }
    if (projectPath.toLowerCase().includes('gis') || JSON.stringify(deps).toLowerCase().includes('gis')) {
      if (!deps['@wdp-api/gis-api']) missingPlugins.push('@wdp-api/gis-api');
    }

    if (missingPlugins.length > 0) {
      return {
        passed: false,
        block: true,
        message: `在 package.json 中未找到必需的插件依赖: ${missingPlugins.join(', ')}`,
        action: `【架构铁律】当前场景涉及 BIM/GIS，必须安装对应插件！请执行 npm install ${missingPlugins.join(' ')}。`,
      };
    }
  } catch (error) {
    return {
      passed: false,
      block: true,
      message: `解析 package.json 失败: ${error}`,
      action: `请修复 package.json 的语法错误`,
    };
  }

  return { passed: true, block: false };
}

export const MCP_TOOL_DEFINITIONS: MpcToolDefinition[] = [
  {
    name: 'start_wdp_workflow',
    description:
      '【WDP 开发入口】所有 WDP、数字孪生、3D 可视化、BIM、GIS、场景交互相关需求都必须先调用此工具。' +
      '它负责路由、参数门禁和 official 文档定位。若信息不充分，会返回需要追问的问题；若未读取 official 真值文档，禁止自行编排 WDP 方法名或参数名。' +
      '【重要】返回结果中包含 mandatoryCheckpoints，编码前必须依次调用这些检查工具。' +
      '【必需】必须提供 projectPath 参数指定工程路径，用于创建本地缓存。',
    inputSchema: {
      type: 'object',
      properties: {
        user_requirement: {
          type: 'string',
          description: '用户原始需求描述，例如"帮我写一个显示 3D 大楼的页面"。',
        },
        projectPath: {
          type: 'string',
          description: '【必需】工程路径，用于创建本地缓存。例如：D:/Projects/智慧园区',
        },
        objectCategory: {
          type: 'string',
          description: '对象类别：Hierarchy/Path/Poi/Window/Particle/Effects/BIM构件/GIS要素/暂无/不涉及',
        },
        objectId: {
          type: 'string',
          description: '对象 Id：eid/entityName/customId/seedId/nodeId/featureId/暂无/不涉及',
        },
        coordinates: {
          type: 'string',
          description: '坐标参数，无则填"暂无"或"不涉及"',
        },
      },
      required: ['user_requirement', 'projectPath'],
    },
  },
  {
    name: 'query_knowledge',
    description:
      '查询 WDP 知识库，并返回技能路由、official 真值文档候选、扩展检索词和澄清问题。' +
      '当证据不足时，此工具会明确提示先补充信息，不能直接生成 WDP API 代码。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '查询关键词、业务场景或问题描述。',
        },
        skill_path: {
          type: 'string',
          description: '可选：指定知识文件路径，例如 "wdp-api-camera-unified/SKILL.md" 或 official 文档路径。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_skill_content',
    description:
      '读取指定知识文件的完整内容。可用于读取 sub skill、official-*.md、模板文件或资源文件。' +
      '需要生成代码时，应优先读取对应 official 真值文档。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '知识文件路径，例如 "wdp-entry-agent/SKILL.md" 或 "official_api_code_example/official-initialize-scene.md"。',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_skills',
    description:
      '列出知识库中的技能与文档。设置 include_references=true 时，会额外列出 official 文档、模板和资源文件，便于发现真值来源。',
    inputSchema: {
      type: 'object',
      properties: {
        include_references: {
          type: 'boolean',
          description: '是否同时列出 official 文档、模板和资源文件。',
        },
      },
    },
  },
  {
    name: 'check_health',
    description: '检查知识引擎与知识库路径的健康状态。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ============ Context Memory 工具 ============
  {
    name: 'read_context_state',
    description:
      '读取上下文状态（system层 或 business层）。system层：系统路由记忆，由服务端自动维护；business层：业务逻辑记忆，由AI手动维护。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: '工程路径，用于定位缓存目录',
        },
        layer: {
          type: 'string',
          enum: ['system', 'business'],
          description: '存储层级：system(系统路由记忆)、business(业务逻辑记忆)',
        },
        path: {
          type: 'string',
          description: '数据路径，如 "currentRouting" 或 "entities.targetNodes"，为空则返回整个层级',
        },
      },
      required: ['projectPath', 'layer'],
    },
  },
  {
    name: 'write_context_state',
    description:
      '写入上下文记忆状态到指定层级。business 层用于业务关键参数（URL、Token、EID 等），由 AI 手动维护；system 层由工作流自动接管，通常无需手动写入。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: '工程路径',
        },
        layer: {
          type: 'string',
          enum: ['business', 'system'],
          description: '存储层级：business(业务逻辑记忆)、system(系统路由记忆)',
        },
        data: {
          type: 'object',
          description: '要写入的数据对象',
        },
      },
      required: ['projectPath', 'layer', 'data'],
    },
  },
  {
    name: 'cleanup_context_memory',
    description:
      '手动清理上下文内存。可用于释放空间或重置状态。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: '工程路径',
        },
        layer: {
          type: 'string',
          enum: ['all', 'system', 'business'],
          description: '要清理的层级，all表示全部',
        },
      },
      required: ['projectPath', 'layer'],
    },
  },
  // ============ 约束检查工具 ============
  {
    name: 'enforce_routing_check',
    description:
      '【强制检查点 - 编码前必须调用】验证是否已读取 workflow 返回的所有必要 skill。' +
      '如果未通过，返回 isError=true，必须停止编码并先读取缺失的 skill。',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_result: {
          type: 'object',
          description: 'start_wdp_workflow 返回的完整结果对象',
        },
        skills_read: {
          type: 'array',
          items: { type: 'string' },
          description: '声称已读取的 skill 路径列表',
        },
      },
      required: ['workflow_result', 'skills_read'],
    },
  },
  {
    name: 'enforce_official_docs_read',
    description:
      '【强制检查点 - 编码前必须调用】验证 requiredOfficialFiles 是否已全部读取。' +
      '如果未通过，返回 isError=true，必须停止编码并先读取 official 真值文档。',
    inputSchema: {
      type: 'object',
      properties: {
        required_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'workflow 返回的 requiredOfficialFiles 列表',
        },
        files_read: {
          type: 'array',
          items: { type: 'string' },
          description: '声称已读取的 official 文件路径列表',
        },
      },
      required: ['required_files', 'files_read'],
    },
  },
  {
    name: 'enforce_context_memory_check',
    description:
      '【强制检查点 - 长任务编码前必须调用】验证是否已启用 context-memory 状态管理。' +
      '如果对话>=1轮或涉及任意 skill 但未启用，返回 isError=true。',
    inputSchema: {
      type: 'object',
      properties: {
        dialogue_rounds: {
          type: 'number',
          description: '当前对话轮数',
        },
        skills_count: {
          type: 'number',
          description: '涉及的 skill 数量',
        },
        memory_enabled: {
          type: 'boolean',
          description: '是否已启用 context-memory',
        },
      },
      required: ['dialogue_rounds', 'skills_count', 'memory_enabled'],
    },
  },
  {
    name: 'enforce_object_ids_valid',
    description:
      '【强制检查点 - 编码前必须调用】验证代码中使用的对象 Id 不是假值（如 YOUR_xxx, TODO, 123 等）。' +
      '如果发现假值且 allowMock=false，返回 isError=true。',
    inputSchema: {
      type: 'object',
      properties: {
        object_ids: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              source: { type: 'string' },
            },
          },
          description: '要检查的对象 Id 列表，每个包含名称、值和来源',
        },
        allow_mock: {
          type: 'boolean',
          description: '是否允许使用 mock 值（仅开发阶段）',
        },
      },
      required: ['object_ids'],
    },
  },
  {
    name: 'enforce_project_scaffolding_valid',
    description:
      '【强制检查点 - 第一轮编码/生成基础框架前必须调用】验证目标目录是否包含 package.json，并且包含 wdpapi 依赖。' +
      '如果通过 html <script> 引入而不使用前端构建工具，返回 isError=true，禁止生成后续代码。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: '目标工程根目录',
        },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'trigger_self_evaluation',
    description:
      '【强制检查点 - 编码后必须调用】在代码编写完成后、向用户汇报之前必须调用。用于触发强制的底线 Review 和生命周期检查。如果发现不符合返回要求的点，你必须自我修复代码。',
    inputSchema: {
      type: 'object',
      properties: {
        written_files: {
          type: 'array',
          items: { type: 'string' },
          description: '刚刚编写或修改的文件路径列表',
        },
        used_skills: {
          type: 'array',
          items: { type: 'string' },
          description: '编码过程中使用的 WDP Skill 列表（例如 "wdp-api-bim-unified"）',
        },
        scenario_id: {
          type: 'string',
          description: '当前识别到的业务场景 ID（如 video-perimeter-monitoring，如果未知则留空）',
        },
      },
      required: ['written_files', 'used_skills'],
    },
  },
];
