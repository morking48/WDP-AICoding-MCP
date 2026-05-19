---
name: wdp-intent-orchestrator
description: WDP 意图编排与需求精确化。用于在编码前把自然语言业务诉求整理成《系统意图与架构设计报告》，完成需求拆解、能力路由、前置参数核查、清理链路补全。
---

# WDP 意图编排技能

只做 4 件事：

1. 解析需求并拆成可执行子任务
2. 从资源中匹配原生 API 能力与子 skill 路由
3. 在编码前拦住缺失参数、错误对象类型、缺失清理链路等问题
4. 输出《系统意图与架构设计报告》

不要在本技能里直接生成业务代码。

## 你已经获得的路由结果

`start_wdp_workflow` 已自动完成以下匹配，你无需手动执行任何路由逻辑：

- **场景模板匹配**（`scene` 字段）：基于 `config/business-scenarios/_index.json`，SCENE 匹配为最高优先级路由（先于关键词匹配）。命中后场景的 `primary_skills + secondary_skills` 直接作为主 Skill 列表
- **关键词加权兜底**（场景未命中时）：基于 `config/skill-route-mapping.json`
- **API 调用模式匹配**（`api_patterns` 字段）：基于 `config/api-patterns.json`

**返回结果中的关键字段**：
- `matched_skills` — 所有需要读取的 Skill 文件路径列表（场景优先排序）
- `workflow_steps` — **权威执行步骤**，请严格按此顺序执行
- `builtin_skills_preview` — 内置 Skill（本文档）的前 1500 字内容预览，已自动注入
- `scene` — 命中的业务场景（名称 + 目标描述）
- `api_patterns` — 匹配的 API 调用模式（`api_sequence + data_flow + notes`）

## 执行流程（严格顺序）

### Step 1-6: 按 `workflow_steps` 执行

请严格按返回结果中的 **`workflow_steps`** 顺序执行。典型步骤包括：

- 读取内置 Skill（已通过 `builtin_skills_preview` 自动注入）
- 读取 `reference/initialization/SKILL.md`（初始化）
- 读取场景核心 Skill / 关键词路由 Skill
- 读取关联 Skill 和场景辅助 Skill
- 参考 API 调用模式（如有）

**所有 WDP API 的正确签名、参数格式和 demo.js 示例均以 Skill 文件为准，禁止凭记忆编造 API 调用。**

### 🚨 防幻觉核心规则

1. **用 `force_full: true` 读取所有 Skill 文件**。返回体中已自动包含 `api_whitelist` — 这是该文件允许使用的全部 API 名列表。你只能使用白名单中的 API。
2. **编码前调用 `enforce_routing_check`**：验证所有必需 Skill 已全文读取。未通过前禁止编码。
3. **编码后调用 `trigger_self_evaluation`**：传入完整代码文本（`generated_code`）+ `used_skills`（从 `workflow_result.matched_skills` 获取）+ `scenario_id`（从 `workflow_result.scene.id` 获取，如场景命中）。MCP 会做 API 白名单存在性比对 + 场景步骤覆盖检查。缺失步骤将被阻断并提示。

> ⚠️ 历史案例：AI 完整读取 camera-control/SKILL.md 后，仍凭记忆编造了 `FocusByEntityName`。
> 实际的 `api_whitelist` 中只有 `FocusToAll`、`Focus`、`FlyTo`、`Follow`、`Around`。
> 仅靠"读了文件"无法防止此类幻觉。编码后务必调用 `trigger_self_evaluation` 做最终验证。

## 统一基线

| 包名 | 版本 |
|------|------|
| 核心 SDK | `wdpapi@^2.3.0` |
| BIM 插件 | `@wdp-api/bim-api@^2.2.1` |
| GIS 插件 | `@wdp-api/gis-api@^2.1.0` |

## 阻断性要求（6条）

1. **路由结果已由 start_wdp_workflow 提供**：以 `matched_skills` + `workflow_steps` 为准，不要手动重新路由
2. **必须读取 initialization**：`reference/initialization/SKILL.md`
3. **Plugin.Install 必须在 Renderer.Start 之前**
4. **核心参数不得为假值**：禁止 YOUR_URL、YOUR_TOKEN 等占位符
5. **必须使用 npm install wdpapi**：禁止 CDN 引入
6. **缺信息时先问，不要猜**

## 工作流

### 1. 解析原始需求

先提取：
- 用户要完成的业务目标
- 涉及的对象类别
- 已知对象 Id
- 已知坐标、位置、范围、角度、时长
- 是否有"进入链路"和"退出/清理链路"

把自然语言需求拆成 1 个主任务和若干子任务。

### 2. 确认路由（已自动完成）

路由结果已通过 `start_wdp_workflow` 返回，场景匹配为最高优先级路由。

> **常用映射参考**（实际路由以 `matched_skills` 和 `workflow_steps` 为准。路由配置文件：`config/skill-route-mapping.json` + `config/business-scenarios/_index.json`）：
>
> | 能力域 | 参考 Skill（可能已变更） |
> |--------|----------------------|
> | 初始化 | `reference/initialization/SKILL.md` |
> | 事件注册 | `reference/renderer/SKILL.md` |
> | 相机控制/跟随 | `reference/camera/camera-control/SKILL.md` |
> | 覆盖物/POI/路径 | `reference/scene/covering/poi/SKILL.md` |
> | BIM 操作 | `reference/system/plugin/bimapi/SKILL.md` |
> | GIS 操作 | `reference/system/plugin/gisapi/SKILL.md` |
> | 场景发现/拾取 | `reference/tools/picker/SKILL.md` + `reference/scene/outliner/SKILL.md` |

### 3. 执行输入门禁

#### 对象门禁
- 先确认对象类别，再确认对象 Id
- 如果只有 Id 没有对象类别，先报缺口
- 对象 Id 的合法来源：创建返回值、屏幕拾取结果、事件回调结果、实体查询结果、BIM 构件查询结果、GIS 要素点击或属性查询结果、平台资源发布信息、outliner 遍历结果

#### 动作门禁
如果需求包含以下动作，必须显式写出原生 API 能力：
- 路径移动、相机跟随、天气切换、高亮、清理回收、屏幕拾取

#### 清理门禁
只要有创建、注册、绑定、启动动作，就必须补充对应退出链路。

#### 真值门禁
禁止：编造 API 名称、编造参数名、编造对象 Id、使用假值

## 输出要求

输出 `《系统意图与架构设计报告》` 到 ` projectpath `，需要包含以下信息：

1. **原始诉求**：用户的自然语言需求
2. **子任务拆解**：主任务和子任务列表
3. **API调用链路**：关键API调用顺序
4. **Skill路由**：Primary和Secondary skill列表（以 `matched_skills` 为准）
5. **已确认输入**：已明确的参数和数据
6. **缺失输入**：需要用户补充的信息
7. **对象信息**：对象类别、Id、Id来源
8. **清理链路**：创建动作与清理动作的对应关系

## 质量底线

1. 先做需求拆解，再做编码路由
2. 先确认对象类别，再确认对象 Id
3. 先确认 Id 来源，再决定后续 API
4. 先确认进入链路，再补清理链路
5. 缺信息时先问，不要猜