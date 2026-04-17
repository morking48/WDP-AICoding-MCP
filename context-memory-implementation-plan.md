# Context-Memory 机制 MCP 优化方案

## 一、背景

`wdp-context-memory` SKILL 已更新，定义了三层架构（Hot/Warm/Cold）和 ReadState/WriteState 接口，但 MCP 服务尚未实现对应功能。

## 二、优化目标

1. 实现 Context-Memory 存储层（本地文件）
2. 添加 ReadState/WriteState MCP 工具
3. 实现自动清理机制
4. 保持与现有 `.wdp-cache` 机制一致

## 三、实施步骤

### Step 1: 新增存储层模块

**文件**: `src/utils/contextMemory.ts`

```typescript
import path from 'path';
import fs from 'fs';

export class ContextMemoryStore {
  private projectPath: string;
  private memoryDir: string;
  private hotCache: Map<string, any>;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.memoryDir = path.join(projectPath, '.wdp-cache', 'context-memory');
    this.hotCache = new Map();
    this.ensureDir();
    this.cleanupExpiredFiles();
  }

  private ensureDir() {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  // Hot 层：内存存储
  readHot(key: string): any {
    return this.hotCache.get(key);
  }

  writeHot(key: string, value: any) {
    this.hotCache.set(key, value);
  }

  clearHot() {
    this.hotCache.clear();
  }

  // Warm/Cold 层：文件存储
  readFile(layer: 'warm' | 'cold'): any {
    const filePath = path.join(this.memoryDir, `${layer}.json`);
    if (fs.existsSync(filePath)) {
      this.updateAccessTime(layer);
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    return {};
  }

  writeFile(layer: 'warm' | 'cold', data: any) {
    const filePath = path.join(this.memoryDir, `${layer}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    this.updateAccessTime(layer);
  }

  // 清理过期文件
  private cleanupExpiredFiles() {
    const metaPath = path.join(this.memoryDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return;

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    // Warm: 7天过期
    if (meta.warmLastAccess && (now - meta.warmLastAccess) > 7 * DAY) {
      const warmPath = path.join(this.memoryDir, 'warm.json');
      if (fs.existsSync(warmPath)) {
        fs.unlinkSync(warmPath);
        console.log('[ContextMemory] Warm 层已过期清理');
      }
    }

    // Cold: 30天过期
    if (meta.coldLastAccess && (now - meta.coldLastAccess) > 30 * DAY) {
      const coldPath = path.join(this.memoryDir, 'cold.json');
      if (fs.existsSync(coldPath)) {
        fs.unlinkSync(coldPath);
        console.log('[ContextMemory] Cold 层已过期清理');
      }
    }
  }

  private updateAccessTime(layer: 'warm' | 'cold') {
    const metaPath = path.join(this.memoryDir, 'meta.json');
    const meta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      : {};
    meta[`${layer}LastAccess`] = Date.now();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}

// 全局存储实例管理
const contextMemoryStores = new Map<string, ContextMemoryStore>();

export function getContextMemoryStore(projectPath: string): ContextMemoryStore {
  if (!contextMemoryStores.has(projectPath)) {
    contextMemoryStores.set(projectPath, new ContextMemoryStore(projectPath));
  }
  return contextMemoryStores.get(projectPath)!;
}

export function cleanupContextMemory(projectPath: string) {
  const store = contextMemoryStores.get(projectPath);
  if (store) {
    store.clearHot();
    contextMemoryStores.delete(projectPath);
  }
}
```

### Step 2: 添加 MCP 工具定义

**文件**: `src/utils/wdpKnowledge.ts`（在 MCP_TOOL_DEFINITIONS 数组中添加）

```typescript
{
  name: 'read_context_state',
  description:
    '读取上下文状态（Hot/Warm/Cold层）。Hot层：运行时状态（currentSkill, selection等）；Warm层：路由链路；Cold层：业务数据。',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: '工程路径，用于定位缓存目录',
      },
      layer: {
        type: 'string',
        enum: ['hot', 'warm', 'cold'],
        description: '存储层级：hot(运行时状态)、warm(路由链路)、cold(业务数据)',
      },
      path: {
        type: 'string',
        description: '数据路径，如 "currentRouting" 或 "entities.targetNodes"，为空则返回整个层级',
      },
    },
    required: ['projectPath', 'layer'],
  },
},
{
  name: 'write_context_state',
  description:
    '写入上下文状态到指定层级。Hot层写入内存，Warm/Cold层写入文件。',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: '工程路径',
      },
      layer: {
        type: 'string',
        enum: ['hot', 'warm', 'cold'],
        description: '存储层级',
      },
      data: {
        type: 'object',
        description: '要写入的数据对象',
      },
    },
    required: ['projectPath', 'layer', 'data'],
  },
},
{
  name: 'cleanup_context_memory',
  description:
    '手动清理上下文内存。可用于释放空间或重置状态。',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: {
        type: 'string',
        description: '工程路径',
      },
      layer: {
        type: 'string',
        enum: ['all', 'hot', 'warm', 'cold'],
        description: '要清理的层级，all表示全部',
      },
    },
    required: ['projectPath', 'layer'],
  },
},
```

### Step 3: 实现工具处理逻辑

**文件**: `src/server.ts`（在 handleMcpToolCall 函数中添加）

```typescript
import { getContextMemoryStore, cleanupContextMemory } from './utils/contextMemory';
import { get } from 'lodash'; // 需要安装 lodash

// 在 handleMcpToolCall 函数中添加 case

case 'read_context_state': {
  if (!args?.projectPath || !args?.layer) {
    return {
      content: [{ type: 'text', text: '错误: 缺少 projectPath 或 layer 参数' }],
      isError: true,
    };
  }

  const store = getContextMemoryStore(args.projectPath);
  let result;

  if (args.layer === 'hot') {
    result = args.path ? store.readHot(args.path) : Object.fromEntries(store['hotCache']);
  } else {
    const data = store.readFile(args.layer);
    result = args.path ? get(data, args.path) : data;
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }],
  };
}

case 'write_context_state': {
  if (!args?.projectPath || !args?.layer || !args?.data) {
    return {
      content: [{ type: 'text', text: '错误: 缺少必要参数' }],
      isError: true,
    };
  }

  const store = getContextMemoryStore(args.projectPath);

  if (args.layer === 'hot') {
    Object.entries(args.data).forEach(([key, value]) => {
      store.writeHot(key, value);
    });
  } else {
    const existing = store.readFile(args.layer);
    store.writeFile(args.layer, { ...existing, ...args.data });
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, message: '写入成功' }) }],
  };
}

case 'cleanup_context_memory': {
  if (!args?.projectPath || !args?.layer) {
    return {
      content: [{ type: 'text', text: '错误: 缺少必要参数' }],
      isError: true,
    };
  }

  const store = getContextMemoryStore(args.projectPath);

  if (args.layer === 'all' || args.layer === 'hot') {
    store.clearHot();
  }

  if (args.layer === 'all' || args.layer === 'warm') {
    const warmPath = path.join(args.projectPath, '.wdp-cache', 'context-memory', 'warm.json');
    if (fs.existsSync(warmPath)) fs.unlinkSync(warmPath);
  }

  if (args.layer === 'all' || args.layer === 'cold') {
    const coldPath = path.join(args.projectPath, '.wdp-cache', 'context-memory', 'cold.json');
    if (fs.existsSync(coldPath)) fs.unlinkSync(coldPath);
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, message: '清理完成' }) }],
  };
}
```

### Step 4: 会话结束清理

**文件**: `src/server.ts`（在 start_wdp_workflow 处理中添加）

```typescript
// 在 start_wdp_workflow case 中，记录 projectPath 变化时清理
const previousProjectPath = sessionProjectPath.get(sessionId);
if (previousProjectPath && previousProjectPath !== args.projectPath) {
  cleanupContextMemory(previousProjectPath);
}
sessionProjectPath.set(sessionId, args.projectPath);
```

### Step 5: 依赖安装

```bash
npm install lodash
npm install --save-dev @types/lodash
```

## 四、文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/utils/contextMemory.ts` | 新增 | 存储层实现 |
| `src/utils/wdpKnowledge.ts` | 修改 | 添加工具定义 |
| `src/server.ts` | 修改 | 添加工具处理逻辑 |
| `package.json` | 修改 | 添加 lodash 依赖 |

## 五、测试验证

1. **读取测试**
```bash
curl -X POST http://localhost:3000/mcp/call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "read_context_state",
    "arguments": {
      "projectPath": "D:/Projects/Test",
      "layer": "hot",
      "path": "currentSkill"
    }
  }'
```

2. **写入测试**
```bash
curl -X POST http://localhost:3000/mcp/call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "write_context_state",
    "arguments": {
      "projectPath": "D:/Projects/Test",
      "layer": "hot",
      "data": { "currentSkill": "wdp-api-bim-unified" }
    }
  }'
```

## 六、注意事项

1. **并发安全**: 本地文件存储，每个工程独立，无并发冲突
2. **存储位置**: `{projectPath}/.wdp-cache/context-memory/`
3. **自动清理**: Warm 7天、Cold 30天过期
4. **Hot 层**: 进程重启或 projectPath 变化时清空

## 七、实施建议

1. 先实现 Step 1-3（核心功能）
2. 测试验证通过后再实现 Step 4（会话清理）
3. 最后更新文档和推送代码

---

**确认后我将开始实施具体代码修改。**
