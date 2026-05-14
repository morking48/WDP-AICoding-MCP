---
name: wdp-context-memory
description: WDP 上下文状态管理双层架构。System 层（路由缓存与任务摘要，Server+客户端自动维护），Business 层（业务参数缓存，AI 手动维护）。所有数据存储在用户本地，服务端无状态。
---

# WDP Context Memory

## 核心定位

防止长对话后业务状态与路由配置丢失，提供跨轮对话的上下文连续性。

| 层级 | 内容 | 维护者 | 使用方式 |
|------|------|--------|------------|
| **System** | workflow 匹配的技能、任务摘要、当前路由配置 | **Server/客户端自动维护** | `start_wdp_workflow` 返回时自动注入 `activeContext` |
| **Business**| 业务关键参数（URL、Token、坐标、生成的模型 ID 等） | **AI 助手主动写入** | 调用客户端本地工具 `write_context_state({layer: "business", data: {...}})` |

**数据归属**：所有缓存文件存储在用户本地 `{projectPath}/.wdp-cache/context-memory/` 目录下。Server 端不存储任何用户数据。

---

## System 层（自动维护，无需主动写入）

### 你不需要主动管理和读取 System 层

每次调用 `start_wdp_workflow` 时，`activeContext` 会自动注入到返回结果中：

```json
{
  "activeContext": {
    "layer": "system",
    "summary": "当前任务：BIM楼层拆解场景 | 关键 Skill: reference/system/plugin/bimapi/SKILL.md",
    "data": {
      "matchedSkills": ["reference/system/plugin/bimapi/SKILL.md", "reference/camera/camera-control/SKILL.md"],
      "requiredRelatedSkills": ["reference/system/plugin/bimapi/hierarchy/SKILL.md"],
      "keywords": ["plugin-bim", "camera"]
    },
    "hint": "【架构记忆】这是本地缓存的原始设计意图，若后续步骤产生幻觉，请优先以此为准。若丢失路由，调用 read_context_state(layer=\"system\") 恢复。"
  }
}
```

### System 层实际存储的字段

| 字段 | 说明 |
|------|------|
| `contextSummary` | 当前任务摘要（原始需求片段） |
| `matchedSkills` | 本次匹配的所有 Skill 路径列表 |
| `requiredRelatedSkills` | 关联的 Skill 路径（场景辅助 Skill） |
| `primaryDomain` | 主路由领域（如 plugin-bim / camera） |
| `updatedAt` | 最后更新时间戳 |

> **注意**：以上字段由 Server 端在每次 `start_wdp_workflow` 时自动写入，或客户端在拦截时补充。你无需手动操作 System 层。

**若后续对话中丢失路由或参数**：
1. 调用客户端本地工具 `read_context_state(layer="system")` 恢复路由
2. 调用客户端本地工具 `read_context_state(layer="business")` 恢复业务参数
**禁止凭记忆继续，优先查缓存。**

> ⚠️ `read_context_state` 和 `write_context_state` 是**客户端本地工具**（由 `mcp-proxy-client.js` 注册），不在 Server 的 MCP 工具列表中。如果 IDE 直连 Server 而非通过代理客户端，这些工具不可用。

---

## Business 层（AI 手动维护）

### 什么时候调用 `write_context_state`？

**只要在对话中产生了明确的、对后续有用的关键业务数据，就应该立即保存！**

**典型场景**：
- 用户确认了正确的 WDP Server URL 和 Order 口令
- 生成/导入 BIM 模型后获取到的 `eid` 或 `assetId`
- 从 API 返回值里拿到的关键业务坐标、空间边界 (`location` / `bound`)
- 处理大体量数据（如 `reference/scene/outliner/SKILL.md` 发现的上百个实体快照）
- 用户输入中提供的对象类别、对象 Id、坐标参数

**调用要求**：
- `layer` 参数固定传 `"business"`
- 数据会自动合并保存到本地 `business.json`（客户端本地工具处理）
- 下次调用 `start_wdp_workflow` 时，这些数据会通过 `_business_context` 自动推送给你

**示例**：
```javascript
// 当获取到重要的模型实体 ID 后，立即存入业务记忆
write_context_state({
  projectPath: "D:/Projects/智慧园区",
  layer: "business",
  data: { 
    coreConfig: { serviceUrl: "https://...", order: "abc123" },
    targetEid: "model-123"
  }
});
```

### 什么时候你会收到 Business 层数据？

每次调用 `start_wdp_workflow` 时，如果本地 `business.json` 中有数据，客户端会自动注入：

```json
{
  "_business_context": {
    "layer": "business",
    "data": {
      "userInputParams": { "objectCategory": "BIM构件" },
      "coreConfig": { "serviceUrl": "https://...", "order": "abc123" }
    },
    "hint": "【业务参数记忆】这是之前对话中保存的关键参数，请勿重复询问用户，优先复用。"
  }
}
```

**请优先复用这些参数**，不要重复询问用户已提供过的信息。

---

## 一句话总结

> **System 层由 Server/客户端自动维护（`activeContext` 自动推送），你只需在获取关键业务参数后调用 `write_context_state`（客户端本地工具）写入 Business 层。所有数据存储在用户本地，跨轮对话自动继承。**