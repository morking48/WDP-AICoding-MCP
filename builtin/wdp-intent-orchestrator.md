---
name: wdp-intent-orchestrator
description: WDP 意图编排与需求精确化。用于在编码前把自然语言业务诉求整理成《系统意图与架构设计报告》，完成需求拆解、能力路由、前置参数核查、清理链路补全和长流程状态管理判断。
---

# WDP 意图编排技能

只做 4 件事：

1. 解析需求并拆成可执行子任务
2. 从资源中匹配原生 API 能力与子 skill 路由
3. 在编码前拦住缺失参数、错误对象类型、缺失清理链路等问题
4. 输出《系统意图与架构设计报告》

不要在本技能里直接生成业务代码。

## 执行流程（严格顺序）

### Step 0: 长流程判断

如果符合以下任一条件，必须先启用 `wdp-context-memory`：
- 预计超过 5 步
- 跨多个 WDP 子 skill
- 需要跨多轮对话完成
- 需要保留选中状态、相机状态、任务进度

### Step 1: 意图编排

调用 `start_wdp_workflow`，MCP 已自动完成：
- 场景模板匹配（基于 `config/business-scenarios/`）
- 关键词路由（基于 `config/skill-route-mapping.json`）
- API 调用模式匹配（基于 `config/api-patterns.json`）

你收到的 `matched_skills` + `scene` + `api_patterns` 已经是综合命中结果。

### Step 2: 初始化

读取 `reference/initialization/SKILL.md`，确保工程基线正确。

### Step 3: 插件安装（如需要）

如果涉及 BIM/GIS/WIM，读取对应插件 Skill：
- BIM: `reference/system/plugin/bimapi/SKILL.md`
- GIS: `reference/system/plugin/gisapi/SKILL.md`
- WIM: `reference/system/plugin/wimapi/SKILL.md`

**Plugin.Install 必须在 Renderer.Start 之前执行。**

### Step 4: 按需读取功能 + 场景 Skill

根据 `matched_skills` 中的路径，按需读取所有 Skill 文件（含场景匹配的额外 Skill）。

### Step 5: 引用 API 调用模式（如有）

如果返回结果中有 `api_patterns`，直接参考其中的 `api_sequence` + `data_flow` + `notes` 生成代码。

### 🚨 Step 6: 防幻觉强制校验

生成代码前必须调用 `enforce_routing_check`，未通过前禁止生成代码。所有 API 签名以 Skill 文件为准。

## 统一基线

| 包名 | 版本 |
|------|------|
| 核心 SDK | `wdpapi@^2.3.0` |
| BIM 插件 | `@wdp-api/bim-api@^2.2.1` |
| GIS 插件 | `@wdp-api/gis-api@^2.1.0` |

## 阻断性要求（7条）

1. **长流程必须用 context-memory**：超过 5 步或跨 skill 的任务，必须先启用
2. **必须先执行意图编排**：调用 `start_wdp_workflow` 获取路由结果
3. **必须读取 initialization**：`reference/initialization/SKILL.md`
4. **Plugin.Install 必须在 Renderer.Start 之前**
5. **核心参数不得为假值**：禁止 YOUR_URL、YOUR_TOKEN 等占位符
6. **必须使用 npm install wdpapi**：禁止 CDN 引入
7. **缺信息时先问，不要猜**

## 工作流

### 1. 解析原始需求

先提取：
- 用户要完成的业务目标
- 涉及的对象类别
- 已知对象 Id
- 已知坐标、位置、范围、角度、时长
- 是否有"进入链路"和"退出/清理链路"

把自然语言需求拆成 1 个主任务和若干子任务。

### 2. 匹配能力与路由

> ⚠️ **MCP 已在 `start_wdp_workflow` 时自动完成场景模板匹配和歧义消解**。你收到的 `matchedSkills` 已经是场景命中的结果。

**新版 Skill 路由表**（常用映射）：

| 能力域/关键词 | 目标 Skill |
|-------------|-----------|
| `initialization` / 初始化 | `reference/initialization/SKILL.md` |
| `events` / 事件注册 | `reference/renderer/SKILL.md` |
| `camera` / 相机 / 跟随 | `reference/camera/camera-control/SKILL.md` |
| `base-attributes` | `reference/_shared/object-base.md` |
| `entity-behavior` / 路径移动 | `reference/scene/covering/bound/SKILL.md` |
| `coverings` / 覆盖物 / 路径 / POI | `reference/scene/covering/poi/SKILL.md` (主) + 16个子覆盖物 |
| `layers-models` | `reference/scene/model/static/SKILL.md` (主) + 11个模型子类 |
| `materials` | `reference/data-model/material/SKILL.md` |
| `cluster` | `reference/data-model/cluster/SKILL.md` |
| `function-components` / 拾取 | `reference/tools/picker/SKILL.md` (主) + 10个工具子类 |
| `bim` / bim-core / 构件 | `reference/system/plugin/bimapi/SKILL.md` |
| `gis` / GIS要素 | `reference/system/plugin/gisapi/SKILL.md` |
| `spatial-understanding` / 空间/坐标信息获取 | `reference/tools/coordinate/SKILL.md` |
| `scene-discovery` / 场景发现 / 拾取 / 要素查询 | `reference/scene/outliner/SKILL.md` + `reference/tools/picker/SKILL.md` |

> **注意**：新版无独立的 `wdp-api-scene-discovery` Skill，场景发现功能由 `reference/scene/outliner/SKILL.md` + `reference/tools/picker/SKILL.md` 共同承担。

### 3. 执行输入门禁

#### 对象门禁
- 先确认对象类别，再确认对象 Id
- 如果只有 Id 没有对象类别，先报缺口
- 对象 Id 的合法来源：创建返回值、屏幕拾取结果、事件回调结果、实体查询结果、BIM 构件查询结果、GIS 要素点击或属性查询结果、平台资源发布信息、outliner 遍历结果、context-memory Business 层缓存快照

#### 动作门禁
如果需求包含以下动作，必须显式写出原生 API 能力：
- 路径移动、相机跟随、天气切换、高亮、清理回收、屏幕拾取

#### 清理门禁
只要有创建、注册、绑定、启动动作，就必须补充对应退出链路。

#### 真值门禁
禁止：编造 API 名称、编造参数名、编造对象 Id、使用假值

## 输出要求

输出 `《系统意图与架构设计报告》`：

1. **原始诉求**：用户的自然语言需求
2. **子任务拆解**：主任务和子任务列表
3. **API调用链路**：关键API调用顺序
4. **Skill路由**：Primary和Secondary skill列表
5. **已确认输入**：已明确的参数和数据
6. **缺失输入**：需要用户补充的信息
7. **对象信息**：对象类别、Id、Id来源
8. **清理链路**：创建动作与清理动作的对应关系
9. **状态管理判断**：是否启用 `wdp-context-memory`

## 质量底线

1. 先做需求拆解，再做编码路由
2. 先确认对象类别，再确认对象 Id
3. 先确认 Id 来源，再决定后续 API
4. 先确认进入链路，再补清理链路
5. 长流程任务必须挂上 `wdp-context-memory`
6. 缺信息时先问，不要猜