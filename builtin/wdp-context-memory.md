---
name: wdp-context-memory
description: WDP 上下文状态管理双层架构。System 层（系统路由缓存，代理客户端自动推送），Business 层（业务逻辑缓存，AI手动维护）。所有数据存储在用户本地，服务端无状态。
---

# WDP Context Memory

## 核心定位

防止长对话后业务状态与路由配置丢失，提供跨轮对话的上下文连续性。

| 层级 | 内容 | 维护者 | 使用方式 |
|------|------|--------|------------|
| **System** | workflow匹配的技能、摘要、当前路由配置、技能快照 | **代理客户端自动推送** | `start_wdp_workflow` 返回时自动注入 `activeContext` |
| **Business**| 业务关键参数（如URL、Token、坐标、生成的模型ID、核心场景配置等） | **AI助手主动写入** | `write_context_state({layer: "business", data: {...}})` |

**数据归属**：所有缓存文件存储在用户本地 `{projectPath}/.wdp-cache/context-memory/` 目录下，服务端不存储任何用户数据。

---

## System 层（代理客户端自动处理）

### 你不需要主动读取 System 层

代理客户端会在每次调用 `start_wdp_workflow` 时，**自动**将以下信息注入返回结果：

```json
{
  "activeContext": {
    "layer": "system",
    "summary": "当前任务：实现BIM高亮... | 必须真值：reference/system/plugin/bimapi/SKILL.md",
    "data": {
      "matchedSkills": ["reference/system/plugin/bimapi/SKILL.md"],
      "requiredOfficialFiles": ["reference/system/plugin/bimapi/hierarchy/SKILL.md"],
      "skillsSnapshot": [...],
      "officialIndex": [...]
    },
    "hint": "【架构记忆】这是本地缓存的原始设计意图，若后续步骤产生幻觉，请优先以此为准。"
  }
}
```

**⚠️ 若后续对话中丢失路由或参数**：
1) 立即调用 `read_context_state(layer="system")` 恢复路由
2) 立即调用 `read_context_state(layer="business")` 恢复业务参数
**禁止凭记忆继续，优先查缓存。**

**请认真阅读 `activeContext` 中的内容**，它包含了本次任务的原始意图、技能映射和官方文档索引。如果后续对话中出现偏离，请以 `activeContext` 为准修正。

### System 层包含什么

| 字段 | 说明 |
|------|------|
| `currentRouting` | 当前任务匹配的技能和官方文档 |
| `contextSummary` | 任务摘要（原始需求 + 必须真值文档） |
| `routingChain` | 最近 3 次任务的路由历史 |
| `skillsSnapshot` | 已读取技能的摘要快照 |
| `officialIndex` | 已读取官方文档的索引 |

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
- **layer 参数**：固定传 `"business"`
- 代理客户端会自动将数据合并保存到本地 `business.json`
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

每次调用 `start_wdp_workflow` 时，如果本地 `business.json` 中有数据，代理客户端会自动注入：

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

## 与旧机制的区别

| 旧机制 | 新机制 |
|--------|--------|
| System 层由服务端写入 | System 层由代理客户端本地写入 |
| AI 需主动调用 `read_context_state` 读取 system | `start_wdp_workflow` 自动推送 `activeContext` |
| 数据存在远程服务器 | 数据存在用户本地 `.wdp-cache/` |
| 服务端有状态 | 服务端无状态，纯桥接 |

---

## 一句话总结

> **代理客户端自动推送 System 层上下文，你只需在获取关键业务参数后调用 `write_context_state` 写入 Business 层。所有数据存储在用户本地，跨轮对话自动继承。**