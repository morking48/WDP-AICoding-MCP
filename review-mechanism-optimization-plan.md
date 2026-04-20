# MCP Knowledge Server 增强 Review 与容错机制优化方案

## 核心目标

在不增加服务器算力负担、充分利用已有知识库和本地存储机制的前提下，提升 WDP 代码生成的稳定性和质量，特别是防范低级但致命的错误。考虑到用户端大模型智商参差不齐，重要流程将采用**硬编码强控制**。

## 设计原则

1. **硬编码兜底 (Hardcoded Guardrails)**：对于非智能模型容易忽略的关键步骤（如：引入核心依赖、必须读的文档、清理函数），在 MCP 服务端进行硬编码断言拦截。
2. **底线 Review (Bottom-line Evaluation)**：放弃全面业务逻辑验证，专注于致命低级错误的 Review（例如：未清理事件造成的内存泄漏、API 签名完全错误、使用了占位符）。
3. **本地化缓存 (Client-local Storage)**：严格遵循“零服务器存储负担”原则，所有新增状态、校验日志均写入客户端当前工程的 `.wdp-cache` 目录。

---

## 优化方案拆解

### 1. 强化硬编码的前置约束（针对低智模型）

低智模型经常会忽略 system prompt 里的“必须先读文档”的指令。我们需要在 `start_wdp_workflow` 中不仅返回指令，更要在后续 MCP 工具调用中加入**硬状态校验**。

**具体实现方案**：
*   **状态追踪**：利用已有的 `ContextMemoryStore`（已在 `.wdp-cache` 中实现），当工作流启动时，在 `warm` 层记录必须读取的 `official-*.md` 列表。
*   **读取拦截**：修改 `get_skill_content` 工具，每次读取 official 文档时，在 `warm` 层标记该文档已读。
*   **强制阻断**：在 Agent 尝试提供最终结果前，通过现有的 `enforce_official_docs_read` 工具（硬编码），直接对比应读列表和已读列表。如果低智 Agent 试图跳过阅读直接写代码，`isError=true` 直接打断。

### 2. 引入轻量级“底线” Review 机制 (Self-Reflection Checklist)

放弃遍历所有 `business-scenarios` 组合的妄想，转而提供一套**通用且致命**的代码审查 Checklist。

**具体实现方案**：新增 `evaluate_wdp_code` 工具（或称 `trigger_self_evaluation`）。

*   **工作流编排**：在 `start_wdp_workflow` 返回的 `mandatoryCheckpoints` 中，将此工具作为**最后一个必须执行的节点**（"trigger": "代码编写完成后，向用户汇报前"）。
*   **服务端逻辑 (Zero Compute)**：该工具不执行任何复杂的代码解析，而是根据 Agent 传入的 `used_skills`（使用了哪些子域），从本地文件或硬编码的规则库中，拼装一份对应的**极简 Checklist 文本**。

**Checklist 设计（仅抓低级/致命问题）**：
1.  **全局铁律**：是否残留了假数据（`YOUR_ID` / `TODO` / `XXX`）？
2.  **生命周期铁律**：如果是 React/Vue，是否在 `useEffect/onUnmounted` 中成对实现了清理（`Add -> Remove`, `On -> Off`）？（未清理会导致严重的 WDP 渲染引擎内存泄漏）。
3.  **API 签名确认**：你调用的 `WdpApi` 方法名和参数格式，是否 100% 能够在刚才阅读的 `official-xxx.md` 中找到出处？如果靠猜的，立刻重写。

*   **执行方式**：MCP 返回 `isError=true` 或显式的告警文本，强制本地 Agent（无论智商高低，面对工具调用的显式 Error 都会被迫处理）去对照这份清单阅读自己写的代码并进行 Self-healing。

### 3. 基于已有知识库的 Review 增强（动态场景提取）

由于 `business-scenarios.json` 中的业务场景会不断累加，我们不能采用写死的 `if-else`。必须建立一套**动态读取机制**。

**具体实现方案**：
*   **动态场景匹配**：当工作流启动（`start_wdp_workflow`）识别出某个场景 ID 时，服务端从 `business-scenarios.json` 动态加载该场景的完整定义。
*   **提取关键约束**：服务端自动提取该场景的 `primary_skills`、`cleanup_chain`（清理链路要求）和 `key_apis`（关键 API）。
*   **动态生成 Checklist**：当调用 `trigger_self_evaluation` 时，服务端根据提取的动态约束，自动组装审查条目。
*   **提示示例**：“检测到你当前正在实现场景【视频周界场景】。根据该场景的定义，你必须确保代码中包含了以下清理链路：`[删除报警覆盖物, 注销报警回调, 恢复相机视角]`。请立刻核对你的代码，若缺失请补充！”

### 4. 针对“小问题/低级错误”的 Review 机制

大模型在生成 WDP 代码时，经常会犯一些看似极小但会**直接阻断运行或导致严重内存泄漏**的错误。这些不需要高深逻辑判断的错误，是我们要严防死守的。

**防范策略与工具设计**：
在 `trigger_self_evaluation` 返回的审查清单中，**永远置顶**以下针对小问题的“铁律”（Ironclad Rules）：

1.  **占位符残留检查（Mock Data Leak）**：
    *   **Review 指令**：“立即全局搜索你刚才修改的文件。是否存在 `YOUR_URL`, `TODO`, `123`, `[0,0,0]`, `dummy` 等未被真实数据替换的占位符？如果有，**绝对禁止**提交，你必须去寻找真实数据或询问用户。”
2.  **API 大小写与签名检查（Case & Signature Check）**：
    *   **Review 指令**：“WDP API 严格区分大小写（例如 `api.Camera.FlyTo` 而不是 `api.camera.flyTo`）。请对照你刚刚阅读的 `official-xxx.md`，逐字检查你的 API 调用，一个字母都不能错。”
3.  **生命周期成对检查（Lifecycle Pairing Check）**：
    *   **Review 指令**：“在 React/Vue 中，只要你在 `useEffect/mounted` 里写了 `api.Event.On` (注册事件) 或 `api.XX.Add` (添加覆盖物/模型)，你**必须、立刻、马上**去对应的 `return () => {} / unmounted` 块中检查，是否有严格对应的 `api.Event.Off` 或 `api.XX.Remove`。缺失这一步会导致 WDP 引擎内存泄漏至崩溃！”
4.  **初始化顺序检查（Init Order Check）**：
    *   **Review 指令**：“检查 `Plugin.Install` 是否严格放在了 `Renderer.Start` 之前调用？”

**核心机制**：这些小问题依靠大模型强大的**上下文注意力（Attention）**。当我们在 Review 环节用**极其严厉、绝对强制的语气**向它吼出这些铁律时，它就会被迫利用本地算力，像运行 linter 一样去扫一遍自己的代码，从而完成 Self-healing。

### 4. 缓存与状态管理机制优化

坚决不增加服务器负担，复用并强化刚刚完成的 `contextMemory` 机制。

*   **本地存储**：所有 Review 的中间状态、被拦截的错误记录，全部写入客户端工程的 `{projectPath}/.wdp-cache/context-memory/` 下的 `hot.json` 或 `warm.json`。
*   **防止并发冲突**：因为是写在用户本地工程目录，天然实现了用户隔离和并发安全，服务器端 `server.ts` 中的内存仅做极短暂的中转或干脆做成无状态（Stateless）。

---

## 实施待办清单 (Checklist)

- [ ] 1. **修改 `start_wdp_workflow`**：在返回的 `mandatoryCheckpoints` 数组末尾，追加新的检查点 `code_evaluation`。
- [ ] 2. **修改 `src/utils/wdpKnowledge.ts`**：
    - [ ] 在 `MCP_TOOL_DEFINITIONS` 中新增 `trigger_self_evaluation` 工具的定义。
    - [ ] 编写一个静态的、针对不同 Skill 域的“底线 Review 规则字典”（Hardcoded Rule Dictionary）。
- [ ] 3. **修改 `src/server.ts`**：
    - [ ] 实现 `trigger_self_evaluation` 的处理逻辑：接收 `used_skills`，拼接规则字典中的 Checklist 和铁律，返回格式化的字符串（可考虑结合业务场景 JSON）。
- [ ] 4. **复查状态管理机制**：确保上述过程中产生的所有临时数据（如“是否已评测”的状态）均读写于 `ContextMemoryStore`（即本地 `.wdp-cache`），不占用服务端内存。

---

## 结语

这套方案通过 **“服务端硬编码拼装规则 + 强制工具拦截”**，结合 **“本地大模型 Self-healing + 本地文件系统存储状态”**，在不消耗服务端算力、不增加服务器存储的前提下，用一种极其巧妙的 Harness 思想，逼迫各类大模型在交付代码前完成质量兜底，能极大提升 WDP 代码的一次性跑通率。