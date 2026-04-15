# 任务 1：Sub Skill 更新对 MCP 工具链路的影响分析

## 分析时间
2026-04-15

## 分析范围
对比 `wdp-entry-agent/SKILL.md` 的路由规则 与 MCP 服务中的 `SKILL_ROUTE_CONFIGS` 配置

---

## 一、路由映射对比表

| # | wdp-entry-agent 路由规则 | MCP SKILL_ROUTE_CONFIGS | 状态 |
|:---:|:---|:---|:---:|
| 1 | 启动/接入失败 -> `wdp-api-initialization-unified` | 场景初始化 ✅ | 匹配 |
| 2 | 事件不触发 -> `wdp-api-general-event-registration` | 事件注册交互 ✅ | 匹配 |
| 3 | 镜头飞行/相机问题 -> `wdp-api-camera-unified` | 相机控制 ✅ | 匹配 |
| 4 | 属性获取与代理对象 -> `wdp-api-generic-base-attributes` | 实体属性操作 ✅ | 匹配 |
| 5 | 实体检索/显隐/删除 -> `wdp-api-entity-general-behavior` | 实体通用行为 ✅ | 匹配 |
| 6 | 覆盖物创建/更新 -> `wdp-api-coverings-unified` | 覆盖物管理 ✅ | 匹配 |
| 7 | AES底板图层 -> `wdp-api-layer-models` | 图层模型Tiles ✅ | 匹配 |
| 8 | 模型材质替换 -> `wdp-api-material-settings` | 材质设置高亮 ✅ | 匹配 |
| 9 | 点聚合数据部署 -> `wdp-api-cluster` | 点聚合Cluster ✅ | 匹配 |
| 10 | 环境/控件/工具 -> `wdp-api-function-components` | 功能组件特效 ✅ | 匹配 |
| 11 | BIM模型/构件 -> `wdp-api-bim-unified` | BIM模型操作 ✅ | 匹配 |
| 12 | GIS图层接入 -> `gis-api-core-operations` | GIS核心操作 ✅ | 匹配 |
| 13 | 空间理解/坐标转换 -> `wdp-api-spatial-understanding` | 空间理解坐标转换 ✅ | 匹配 |
| 14 | 意图编排 -> `wdp-intent-orchestrator` | ❌ **未在路由配置中** | **缺失** |

**结论**：13个 sub skill 路由完全匹配，但 MCP 中缺少对 `wdp-intent-orchestrator` 的路由配置。

---

## 二、关键词覆盖检查

### wdp-entry-agent 中的关键新增/强调点：

1. **高频错误警示关键词**（需要在 QUERY_ALIAS_GROUPS 中强化）：
   - `npm install wdpapi` / 包名错误
   - `Plugin.Install` 顺序错误
   - `Renderer.Start` 之前/之后
   - `Scene Ready` 等待
   - `YOUR_URL` 假值

2. **路由边界补充**（需要新增或强化）：
   - `Path` 作为可视化路径实体 -> coverings
   - `Bound` / `Scene.Move` 作为实体沿路径运动 -> entity-behavior
   - `CameraControl.Follow` 作为镜头跟随 -> camera
   - 车辆巡检/跟车/跟拍 -> 需要 coverings + entity-behavior + camera 三个子域

3. **长流程任务判断标准**（需要在场景识别中新增）：
   - 预计步骤超过 5 步
   - 跨多个 wdp-api-* skill 调用
   - 保持选中状态、相机位置等上下文
   - 任务可能分多次对话完成

---

## 三、MCP 服务需要做的调整

### 1. 新增路由配置（高优先级）

```typescript
// 在 SKILL_ROUTE_CONFIGS 中新增
{
  label: '意图编排与任务规划',
  skillPath: 'wdp-intent-orchestrator/SKILL.md',
  officialFiles: ['official_api_code_example/OFFICIAL_EXCERPT_INDEX.md'],
  keywords: ['意图编排', '任务规划', '需求拆解', '架构设计', '系统意图', '子任务'],
  scenarios: ['意图编排、复杂任务分解、需求精确化、架构设计报告'],
}
```

### 2. 更新 QUERY_ALIAS_GROUPS（中优先级）

新增以下别名组：

```typescript
// 高频错误相关
{
  triggers: ['npm安装失败', '包名错误', 'wdpapi', '@wdp-api/cloud-api', '导入错误'],
  expansions: ['initialization', 'npm install wdpapi', '包名检查'],
},
// 插件安装顺序
{
  triggers: ['Plugin.Install', 'Renderer.Start顺序', '插件安装失败'],
  expansions: ['initialization', '插件安装顺序', 'Renderer.Start'],
},
// 长流程任务
{
  triggers: ['多步骤', '跨skill', '长流程', '状态保持', '多次对话'],
  expansions: ['context-memory', 'wdp-context-memory', '状态管理'],
},
// 整链路需求
{
  triggers: ['车辆巡检', '跟车', '跟拍', '巡检车', '路线回放'],
  expansions: ['coverings', 'entity-behavior', 'camera', '多skill联动'],
}
```

### 3. 更新场景关键词（中优先级）

在 `detectScene` 函数中新增：

```typescript
'场景8-意图编排与任务规划': ['意图编排', '任务规划', '需求拆解', '架构设计', '系统意图'],
'场景9-长流程状态管理': ['多步骤', '跨skill', '长流程', '状态保持', '多次对话'],
```

---

## 四、是否需要修改 MCP 工具定义

**结论**：当前 `MCP_TOOL_DEFINITIONS` 不需要修改，因为：

1. `start_wdp_workflow` 已经支持动态路由
2. `query_knowledge` 已经支持查询所有 skill
3. `get_skill_content` 已经支持读取任意 skill 内容

但需要确保 `start_wdp_workflow` 的硬编码读取顺序包含 `wdp-intent-orchestrator`。

---

## 五、任务 1 总结

| 检查项 | 状态 | 优先级 |
|:---|:---:|:---:|
| 13个 sub skill 路由映射 | ✅ 匹配 | - |
| wdp-intent-orchestrator 路由 | ❌ 缺失 | **高** |
| QUERY_ALIAS_GROUPS 高频错误关键词 | ⚠️ 需补充 | 中 |
| 长流程任务场景识别 | ⚠️ 需新增 | 中 |
