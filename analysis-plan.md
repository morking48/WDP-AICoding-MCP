# MCP 服务 Skill 更新分析计划

## 术语定义
- **Main skill**: `wdp-entry-agent` - 入口代理，负责路由分发
- **Sub skill**: 通过 `wdp-entry-agent` 路由的所有其他 skill

## 任务拆分

### 任务 1：Sub Skill 更新对 MCP 工具链路的影响分析
**目标**：检查 sub skill 内容更新后，MCP 服务中的工具链路是否需要同步更新

**分析范围**：
1. `src/utils/wdpKnowledge.ts` 中的 `SKILL_ROUTE_CONFIGS` 路由配置
2. `src/utils/wdpKnowledge.ts` 中的 `QUERY_ALIAS_GROUPS` 查询别名
3. `src/server.ts` 中的硬编码 skill 读取顺序
4. `MCP_TOOL_DEFINITIONS` 工具定义是否需要调整

**待检查 skill 列表**（13个）：
- wdp-api-initialization-unified
- wdp-api-general-event-registration
- wdp-api-camera-unified
- wdp-api-generic-base-attributes
- wdp-api-entity-general-behavior
- wdp-api-coverings-unified
- wdp-api-layer-models
- wdp-api-material-settings
- wdp-api-cluster
- wdp-api-function-components
- wdp-api-bim-unified
- gis-api-core-operations
- wdp-api-spatial-understanding

---

### 任务 2：wdp-intent-orchestrator 重大更新分析
**目标**：分析意图识别 skill 的大量内容补充，评估 MCP 服务需要做的调整

**分析范围**：
1. 新的意图识别逻辑 vs 现有 `buildWorkflowResponse` 函数
2. 新的读取顺序要求 vs 现有硬编码读取逻辑
3. 新的报告输出格式 vs 现有响应结构
4. 新增的门禁检查 vs 现有约束检查工具
5. 是否需要新增 MCP 工具或调整现有工具

**关键检查点**：
- 读取顺序变化：`resources/business-scenarios.json` → `resources/api-patterns.json` → `OFFICIAL_EXCERPT_INDEX.md`
- 新的报告章节结构（9个章节）
- 新的合规性检查要求
- 长流程状态管理判断逻辑

---

## 执行顺序
1. 先执行任务 1（Sub skill 分析）
2. 再执行任务 2（Intent orchestrator 分析）
3. 汇总生成修改建议
