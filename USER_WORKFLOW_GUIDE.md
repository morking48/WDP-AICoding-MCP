# WDP MCP 用户使用流程指南

## 模拟场景

**用户需求**："我本地 D:/Projects/智慧园区 的工程中，补充一个BIM模型高亮功能实现"

---

## 第一步：部署 MCP 服务

### 1.1 服务端部署（仅需一次）

**部署人员**：系统管理员/开发者

```bash
# 1. 克隆代码库
git clone https://github.com/morking48/WDP-AICoding-MCP.git
cd mcp-knowledge-server

# 2. 安装依赖
npm install

# 3. 编译TypeScript
npm run build

# 4. 启动服务
npm start
```

**服务启动后**：
```
🚀 WDP 云端知识引擎已启动
📡 HTTP API: http://0.0.0.0:3000
🌐 本地访问: http://localhost:3000
📚 知识库路径: D:/WorkFiles_Codex/mcp-knowledge-server/WDP_AIcoding/skills
```

### 1.2 客户端配置（用户侧）

**用户操作**：在 Cline/Claude 中配置 MCP

```json
{
  "mcpServers": {
    "wdp-knowledge": {
      "command": "node",
      "args": [
        "D:/WorkFiles_Codex/mcp-knowledge-server/remote-client/mcp-proxy-client.js"
      ],
      "env": {
        "WDP_SERVER_URL": "http://localhost:3000",
        "WDP_KNOWLEDGE_TOKEN": "your-token"
      }
    }
  }
}
```

---

## 第二步：首次使用（自动初始化）

### 2.1 客户端启动时自动检测

用户配置好 MCP 客户端后，**客户端启动时**自动检测是否首次使用：

```
🔌 WDP MCP 代理客户端启动中...
📡 远程服务器: http://localhost:3000

🔧 首次使用检测
未找到缓存配置，需要初始化本地缓存。

请选择缓存存储方式：

1. 【推荐】工程目录下创建 .wdp-cache/ 文件夹
   优点：缓存跟随工程，换电脑时一起带走

2. 用户目录下创建缓存
   优点：不污染工程目录

3. 自定义路径

请输入选项 (1/2/3): 1
```

### 2.2 用户选择并初始化

用户选择 **选项1**（工程目录），系统自动：

```
✅ 缓存目录已创建: D:/Projects/智慧园区/.wdp-cache/

缓存内容：
  - Skill 摘要（减少重复读取）
  - 对话状态（长任务续接）
  - 已读文档索引（避免重复读取）

您可以随时删除此目录清理缓存。

✅ MCP 代理客户端已就绪，等待连接...
```

### 2.3 之后正常使用

缓存初始化完成后，用户才能输入指令：

```
调用start_wdp_workflow：了解WDP知识库机制
```

**注意**：缓存初始化在**客户端启动时**完成，不是在用户输入指令后。

---

## 第三步：功能开发流程（模拟场景）

### 场景：补充BIM模型高亮功能

#### 第1轮：启动任务

**用户输入**：
```
调用start_wdp_workflow：实现BIM模型高亮功能

工程路径：D:/Projects/智慧园区
对象类别：BIM构件
对象 Id：暂无
```

**AI执行**：
1. 调用 `start_wdp_workflow`
2. 命中 BIM skill
3. 返回分析结果：

```
📋 任务分析

🎯 目标：实现BIM模型高亮功能
📂 工程：D:/Projects/智慧园区
🔧 涉及技能：wdp-api-bim-unified

⚠️ 缺少信息：
- 对象 Id：需要通过 BIM.Query 获取 nodeId

📖 建议流程：
1. 读取 BIM skill 了解API
2. 确认高亮目标和触发方式
3. 编码实现

是否继续？
```

**本地文件变化**：
```
D:/Projects/智慧园区/
├── .wdp-cache/                    ← 已创建
│   ├── skill-digest.json          ← 空（尚未缓存）
│   ├── session-state.json         ← 记录当前任务
│   └── official-docs-index.json   ← 空
└── src/                           ← 用户工程代码
```

---

#### 第2轮：编码实现

**用户输入**：
```
调用检查点，然后编码：实现BIM模型高亮功能

工程路径：D:/Projects/智慧园区
对象类别：BIM构件
对象 Id：nodeId（通过BIM.Query获取）
```

**AI执行（自动）**：

```
[代理] 请求服务器: wdp-api-bim-unified/SKILL.md
[代理] 已保存到本地缓存: wdp-api-bim-unified/SKILL.md
[代理] 请求服务器: official-bim-full.md
[代理] 已保存到本地缓存: official-bim-full.md
```

**检查点验证**：
```
✅ 检查通过
- 已读取：wdp-api-bim-unified/SKILL.md
- 已读取：official-bim-full.md
- 对象验证：nodeId 将通过 BIM.Query 获取

📝 编码计划
- 目标：实现BIM模型高亮功能
- 修改文件：src/components/BIMViewer.js
- 新增文件：src/utils/bimHelper.js
- 验证方式：运行后点击模型查看高亮效果

确认后开始编码？
```

**用户确认后，AI生成代码**：

```javascript
// src/utils/bimHelper.js
export function highlightBIMModel(nodeId, color = '#ff0000') {
  // 使用官方API实现高亮
  BIM.Highlight(nodeId, { color });
}

// src/components/BIMViewer.js
// ... 集成代码
```

**本地文件变化**：
```
D:/Projects/智慧园区/
├── .wdp-cache/
│   ├── skill-digest.json          ← 新增BIM skill摘要
│   ├── session-state.json         ← 更新进度
│   └── official-docs-index.json   ← 记录已读official文档
├── src/
│   ├── components/
│   │   └── BIMViewer.js           ← 修改（新增高亮功能）
│   └── utils/
│       └── bimHelper.js           ← 新增
```

---

#### 第3轮：功能验证

**用户输入**：
```
运行项目，验证BIM高亮功能是否正常
```

**AI执行**：
- 指导用户运行项目
- 验证高亮效果
- 如有问题进入修复流程

---

#### 第4轮：补充GIS功能（长任务续接）

**用户输入**：
```
检查状态后继续
```

**AI返回**：
```
📋 当前任务状态

🎯 任务目标：智慧园区可视化项目

✅ 已完成：
- BIM模型高亮功能

⏳ 待处理：
- GIS地图集成（用户新需求）
- 信息窗展示

💡 下一步建议：
继续编码GIS功能，输入"调用检查点，然后编码：实现GIS地图底图加载"
```

**用户继续**：
```
调用检查点，然后编码：实现GIS地图底图加载

工程路径：D:/Projects/智慧园区
对象类别：GIS要素
对象 Id：不涉及
```

**AI执行**：
```
[代理] 请求服务器: gis-api-core-operations/SKILL.md
[代理] 已保存到本地缓存: gis-api-core-operations/SKILL.md
```

---

## 第四步：查看本地文件

### 4.1 缓存目录结构

```
D:/Projects/智慧园区/.wdp-cache/
├── skill-digest.json              # Skill摘要缓存
├── session-state.json             # 对话状态
└── official-docs-index.json       # 已读官方文档索引
```

### 4.2 skill-digest.json 内容示例

```json
{
  "version": "1.0.0",
  "createdAt": "2026-04-09T10:00:00Z",
  "updatedAt": "2026-04-09T15:30:00Z",
  "skills": {
    "wdp-api-bim-unified/SKILL.md": {
      "digest": {
        "apis": [
          {
            "name": "BIM.Highlight",
            "params": ["nodeId: string", "options: HighlightOptions"],
            "returnType": "void",
            "keyNotes": ["⚠️ nodeId 必须通过 BIM.Query 获取"]
          }
        ],
        "keyConcepts": ["nodeId", "HighlightOptions"],
        "dependencies": ["wdp-api-initialization-unified"]
      },
      "fileHash": "a1b2c3d4",
      "lastAccessed": "2026-04-09T15:30:00Z",
      "accessCount": 5
    },
    "gis-api-core-operations/SKILL.md": {
      "digest": { ... },
      "fileHash": "e5f6g7h8",
      "lastAccessed": "2026-04-09T16:00:00Z",
      "accessCount": 2
    }
  }
}
```

### 4.3 session-state.json 内容示例

```json
{
  "project": "智慧园区可视化",
  "currentTask": "GIS地图底图加载",
  "completed": [
    "项目初始化",
    "BIM模型高亮功能"
  ],
  "pending": [
    "GIS地图集成",
    "信息窗展示"
  ],
  "skillsInvolved": [
    "wdp-api-bim-unified",
    "gis-api-core-operations"
  ],
  "updatedAt": "2026-04-09T16:00:00Z"
}
```

---

## 第五步：多工程隔离

### 场景：切换到另一个工程

**用户**：在另一个工程 `D:/Projects/数字孪生工厂` 中工作

**系统自动**：
```
检测到新工程：数字孪生工厂
创建独立缓存：D:/Projects/数字孪生工厂/.wdp-cache/
```

**效果**：
- 两个工程缓存完全隔离
- 智慧园区的缓存不影响数字孪生工厂
- 不同工程可以使用不同版本的Skill

---

## 总结：用户视角的完整流程

| 步骤 | 用户操作 | 系统行为 | 本地文件变化 |
|------|---------|---------|-------------|
| 1. 部署 | 配置MCP客户端 | 连接远程服务 | 无 |
| 2. 首次使用 | 选择缓存位置 | 创建.wdp-cache/ | 创建缓存目录 |
| 3. 启动任务 | `调用start_wdp_workflow：xxx` | 分析需求 | 更新session-state.json |
| 4. 编码 | `调用检查点，然后编码：xxx` | 读取skill → 检查 → 编码 | 缓存skill摘要，生成代码 |
| 5. 续接 | `检查状态后继续` | 读取session状态 | 无 |
| 6. 多工程 | 切换工程路径 | 创建独立缓存 | 新工程独立缓存目录 |

### 用户需要关心的文件

1. **工程代码文件** - 正常开发
2. **.wdp-cache/** - 自动管理，可删除清理

### 用户不需要关心的文件

- 远程服务器上的知识库
- 复杂的工具调用逻辑
- 检查点验证细节

---

**版本**：WDP MCP 1.0.0
