# 任务 2：wdp-intent-orchestrator 重大更新分析

## 分析时间
2026-04-15

## 核心发现
`wdp-intent-orchestrator` 已从简单的意图识别升级为**完整的业务场景路由系统**，新增了资源文件和详细的 API 流程定义。

---

## 一、wdp-intent-orchestrator 的重大变化

### 1. 新增资源文件（关键变化）

| 文件 | 用途 | 当前 MCP 是否读取 |
|:---|:---|:---:|
| `resources/business-scenarios.json` | 业务场景路由词典，包含场景定义、任务拆解、skill 路由 | ❌ **未读取** |
| `resources/api-patterns.json` | API 调用模式，包含 api_sequence、skill_sequence、data_flow | ❌ **未读取** |
| `resources/api-compliance-checklist.json` | API 合规性检查清单 | ❌ **未读取** |
| `SKILL.md` | 意图编排流程说明 | ✅ 已读取 |

### 2. 新的读取顺序要求

根据 SKILL.md 第 17-26 行：

```
按顺序读取：
1. resources/business-scenarios.json
2. resources/api-patterns.json
3. ../official_api_code_example/OFFICIAL_EXCERPT_INDEX.md
4. 需要在线核对时再读 ../official_api_code_example/ONLINE_COVERAGE_AUDIT.md
```

**当前 MCP 读取顺序**（server.ts 第 367-371 行）：
```typescript
const skillsToRead = [
  'wdp-entry-agent/SKILL.md',
  'wdp-intent-orchestrator/SKILL.md',  // 只读了 SKILL.md
  ...workflowResult.matchedSkills
];
```

**问题**：没有读取 resources 下的 json 文件！

### 3. 新的报告输出格式（9个章节）

根据 SKILL.md 第 175-232 行，报告必须包含：

1. **原始诉求** - 用户的自然语言需求
2. **子任务拆解** - 主任务和子任务列表
3. **API调用链路** - 关键API调用顺序
4. **Skill路由** - Primary和Secondary skill列表
5. **已确认输入** - 已明确的参数和数据
6. **缺失输入** - 需要用户补充的信息
7. **对象信息** - 对象类别、Id、Id来源
8. **清理链路** - 创建动作与清理动作的对应关系
9. **状态管理判断** - 是否启用 wdp-context-memory

**当前 MCP 响应结构**（server.ts 第 421-444 行）：
- 包含 `scene`, `isScene5`, `isLongTask`, `hasObjectOperation`
- 包含 `skillsRead`, `officialsRead`
- 包含 `checks.contextMemory`, `checks.objectIds`

**对比**：缺少子任务拆解、API调用链路、缺失输入、对象信息、清理链路等关键章节。

### 4. 长流程任务判断标准变化

**wdp-intent-orchestrator 标准**（SKILL.md 第 128-134 行）：
- 预计超过 5 步
- 跨多个 WDP 子 skill
- 需要跨多轮对话完成
- 需要保留选中状态、相机状态、任务进度

**当前 MCP 判断逻辑**（server.ts 第 405 行）：
```typescript
const isLongTask = workflowResult.matchedSkills.length > 1 || workflowResult.requiredOfficialFiles.length > 1;
```

**问题**：判断逻辑过于简单，没有考虑步骤数、多轮对话等因素。

---

## 二、MCP 服务需要做的调整

### 1. 修改读取顺序（高优先级）

修改 `src/server.ts` 第 367-371 行：

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

// 新增：读取 official excerpt index
const officialIndexPath = 'official_api_code_example/OFFICIAL_EXCERPT_INDEX.md';
```

### 2. 新增 MCP 工具（中优先级）

考虑新增以下工具：

```typescript
{
  name: 'get_intent_analysis',
  description: '获取意图编排分析结果，包含业务场景匹配、API模式推荐、任务拆解等',
  inputSchema: {
    type: 'object',
    properties: {
      user_requirement: { type: 'string' },
      scenario_id: { type: 'string', description: '可选：指定业务场景ID' }
    },
    required: ['user_requirement']
  }
}
```

### 3. 优化长流程判断逻辑（中优先级）

修改 `src/server.ts` 第 405 行：

```typescript
// 长流程判断（基于 wdp-intent-orchestrator 标准）
const isLongTask = 
  workflowResult.matchedSkills.length > 1 || 
  workflowResult.requiredOfficialFiles.length > 1 ||
  workflowResult.workflowSteps?.length > 5 ||  // 超过5步
  /多轮|多次对话|状态保持|跨skill/i.test(userRequirement);  // 关键词匹配
```

### 4. 扩展响应结构（低优先级）

在 `buildWorkflowResponse` 返回结构中添加：

```typescript
interface WorkflowResponse {
  // ... 现有字段
  
  // 新增：意图编排相关
  intentAnalysis?: {
    scenarioMatched?: string;      // 匹配的业务场景
    taskBreakdown?: string[];      // 子任务拆解
    apiFlow?: Array<{step: number, api: string, description: string}>;  // API调用链路
    missingInputs?: string[];      // 缺失输入
    objectInfo?: {
      category?: string;           // 对象类别
      idSource?: string;           // Id来源
    };
    cleanupChain?: Array<{create: string, cleanup: string}>;  // 清理链路
  };
}
```

---

## 三、业务场景和 API 模式数据

### business-scenarios.json 中的场景示例

- `video-perimeter-monitoring` - 视频周界场景
- 包含：keywords、synonyms、task_breakdown、primary_skills、secondary_skills
- 包含详细的 api_flow 和 cleanup_chain

### api-patterns.json 中的模式示例

- `wdp-poi-window-interaction` - POI弹窗交互模式
- `wdp-path-roam-animation` - 路径漫游与跟随模式
- `wdp-perimeter-warning` - 周界安防与告警模式
- 包含：api_sequence、skill_sequence、data_flow、notes

**这些数据目前 MCP 服务完全没有利用！**

---

## 四、任务 2 总结

| 检查项 | 当前状态 | 需要调整 | 优先级 |
|:---|:---:|:---:|:---:|
| 读取 resources/business-scenarios.json | ❌ 未读取 | ✅ 需要 | **高** |
| 读取 resources/api-patterns.json | ❌ 未读取 | ✅ 需要 | **高** |
| 读取 OFFICIAL_EXCERPT_INDEX.md | ❌ 未读取 | ✅ 需要 | **高** |
| 报告格式（9个章节） | ⚠️ 部分匹配 | ⚠️ 建议扩展 | 中 |
| 长流程判断逻辑 | ⚠️ 过于简单 | ⚠️ 建议优化 | 中 |
| 新增 MCP 工具 | ❌ 无 | ⚠️ 可选 | 低 |

**关键问题**：MCP 服务目前只读取了 `wdp-intent-orchestrator/SKILL.md`，**完全没有利用新增的资源文件**，这会导致意图编排的能力大打折扣。

---

## 五、下一步建议

1. **立即修改** `src/server.ts` 的读取顺序，包含 resources 文件
2. **测试验证** 新的读取顺序是否正常工作
3. **评估** 是否需要新增 `get_intent_analysis` 工具
4. **优化** 长流程判断逻辑和响应结构
