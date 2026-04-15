# MCP 服务 Skill 更新升级汇总报告

## 报告生成时间
2026-04-15

## 分析文件
- `task1-subskill-analysis.md` - Sub skill 路由分析
- `task2-intent-orchestrator-analysis.md` - 意图编排重大更新分析

---

## 一、核心发现总结

### 🔴 高优先级问题（必须修复）

| # | 问题 | 影响 | 修复文件 |
|:---:|:---|:---|:---|
| 1 | **未读取意图编排资源文件** | 意图识别能力大打折扣 | `src/server.ts` |
| 2 | **缺少 wdp-intent-orchestrator 路由配置** | 无法路由到意图编排 skill | `src/utils/wdpKnowledge.ts` |
| 3 | **未读取 OFFICIAL_EXCERPT_INDEX.md** | 无法获取 official 文档索引 | `src/server.ts` |

### 🟡 中优先级优化（建议修复）

| # | 问题 | 影响 | 修复文件 |
|:---:|:---|:---|:---|
| 4 | QUERY_ALIAS_GROUPS 缺少高频错误关键词 | 无法识别 npm 安装、插件顺序等问题 | `src/utils/wdpKnowledge.ts` |
| 5 | 长流程判断逻辑过于简单 | 可能漏判需要状态管理的任务 | `src/server.ts` |
| 6 | 场景识别缺少意图编排和长流程场景 | 场景判断不完整 | `src/utils/logger.ts` |

### 🟢 低优先级优化（可选）

| # | 问题 | 影响 | 修复文件 |
|:---:|:---|:---|:---|
| 7 | 响应结构缺少意图编排的 9 个章节 | 报告信息不完整 | `src/utils/wdpKnowledge.ts` |
| 8 | 可考虑新增 get_intent_analysis 工具 | 提供更专业的意图分析 | `src/utils/wdpKnowledge.ts` |

---

## 二、具体修改清单

### 修改 1：更新 SKILL_ROUTE_CONFIGS（高优先级）

**文件**：`src/utils/wdpKnowledge.ts` 第 157-256 行

**操作**：在数组末尾新增意图编排路由

```typescript
{
  label: '意图编排与任务规划',
  skillPath: 'wdp-intent-orchestrator/SKILL.md',
  officialFiles: ['official_api_code_example/OFFICIAL_EXCERPT_INDEX.md'],
  keywords: ['意图编排', '任务规划', '需求拆解', '架构设计', '系统意图', '子任务', '业务场景'],
  scenarios: ['意图编排、复杂任务分解、需求精确化、架构设计报告'],
}
```

---

### 修改 2：更新读取顺序（高优先级）

**文件**：`src/server.ts` 第 367-371 行

**操作**：修改 skillsToRead 数组

```typescript
// 硬编码读取必要技能（按 wdp-intent-orchestrator 要求的顺序）
const skillsToRead = [
  'wdp-entry-agent/SKILL.md',
  // 按意图编排要求的顺序读取资源文件
  'wdp-intent-orchestrator/resources/business-scenarios.json',
  'wdp-intent-orchestrator/resources/api-patterns.json',
  'wdp-intent-orchestrator/SKILL.md',
  ...workflowResult.matchedSkills
];

// 新增：读取 official excerpt index（如果存在）
const officialIndexPath = 'official_api_code_example/OFFICIAL_EXCERPT_INDEX.md';
try {
  const indexContent = readKnowledgeFile(KNOWLEDGE_BASE_PATH, officialIndexPath);
  if (indexContent) {
    skillContents.push({ path: officialIndexPath, content: indexContent.substring(0, 1000) + '...' });
    backendCalls.push({ type: 'official', path: officialIndexPath, status: 'success' });
  }
} catch (error) {
  console.error(`[Workflow] 未找到 ${officialIndexPath}`);
}
```

---

### 修改 3：更新 QUERY_ALIAS_GROUPS（中优先级）

**文件**：`src/utils/wdpKnowledge.ts` 第 114-155 行

**操作**：在数组末尾新增以下别名组

```typescript
// 高频错误相关
{
  triggers: ['npm安装失败', '包名错误', 'wdpapi', '@wdp-api/cloud-api', '导入错误', '安装失败'],
  expansions: ['initialization', 'npm install wdpapi', '包名检查', 'wdpapi@^2.3.0'],
},
// 插件安装顺序
{
  triggers: ['Plugin.Install', 'Renderer.Start顺序', '插件安装失败', '顺序错误'],
  expansions: ['initialization', '插件安装顺序', 'Renderer.Start', '必须在之前'],
},
// 长流程任务
{
  triggers: ['多步骤', '跨skill', '长流程', '状态保持', '多次对话', '跨多个'],
  expansions: ['context-memory', 'wdp-context-memory', '状态管理', '长流程任务'],
},
// 整链路需求
{
  triggers: ['车辆巡检', '跟车', '跟拍', '巡检车', '路线回放', '漫游', '跟随'],
  expansions: ['coverings', 'entity-behavior', 'camera', '多skill联动', '整链路'],
},
// 意图编排
{
  triggers: ['意图编排', '任务规划', '需求拆解', '架构设计', '系统意图', '业务场景'],
  expansions: ['wdp-intent-orchestrator', '意图编排', '任务拆解', '架构设计'],
}
```

---

### 修改 4：优化长流程判断逻辑（中优先级）

**文件**：`src/server.ts` 第 405 行

**操作**：扩展 isLongTask 判断

```typescript
// 长流程判断（基于 wdp-intent-orchestrator 标准）
const isLongTask = 
  workflowResult.matchedSkills.length > 1 || 
  workflowResult.requiredOfficialFiles.length > 1 ||
  workflowResult.workflowSteps?.length > 5 ||  // 超过5步
  /多轮|多次对话|状态保持|跨skill|跨多个|长流程/i.test(userRequirement);  // 关键词匹配
```

---

### 修改 5：更新场景识别（中优先级）

**文件**：`src/utils/logger.ts` 第 748-756 行

**操作**：在 SCENE_KEYWORDS 中新增场景

```typescript
const SCENE_KEYWORDS = {
  // ... 现有场景
  
  '场景8-意图编排与任务规划': ['意图编排', '任务规划', '需求拆解', '架构设计', '系统意图', '业务场景'],
  '场景9-长流程状态管理': ['多步骤', '跨skill', '长流程', '状态保持', '多次对话', '跨多个'],
};
```

---

## 三、验证清单

修改完成后，请验证以下功能：

- [ ] `npm run build` 编译成功
- [ ] `npm start` 启动无错误
- [ ] 调用 `start_wdp_workflow` 时读取了 business-scenarios.json
- [ ] 调用 `start_wdp_workflow` 时读取了 api-patterns.json
- [ ] 调用 `start_wdp_workflow` 时读取了 OFFICIAL_EXCERPT_INDEX.md
- [ ] 查询"意图编排"相关关键词能匹配到 wdp-intent-orchestrator
- [ ] 长流程任务（如"车辆巡检跟拍"）正确触发 context-memory 检查

---

## 四、部署建议

1. **本地测试**：先在本机验证所有修改
2. **提交代码**：`git add -A && git commit -m "feat: 适配 skill 更新，优化意图编排能力"`
3. **推送仓库**：`git push origin main && git push gitlab main`
4. **Jenkins 构建**：点击"一键 build"
5. **线上验证**：测试关键业务流程

---

## 五、风险提示

1. **resources 文件必须存在**：如果 `wdp-intent-orchestrator/resources/` 目录不存在，会导致读取失败
2. **JSON 文件格式**：确保 business-scenarios.json 和 api-patterns.json 是合法 JSON
3. **内存占用**：读取大型 JSON 文件可能增加内存占用，注意观察

---

## 六、后续优化建议（可选）

1. **新增 get_intent_analysis 工具**：专门用于意图编排分析
2. **利用业务场景数据**：在 buildWorkflowResponse 中使用 business-scenarios.json 的场景匹配
3. **利用 API 模式数据**：在响应中返回推荐的 api_sequence 和 skill_sequence
4. **合规性检查**：读取 api-compliance-checklist.json 进行 API 合规性验证
