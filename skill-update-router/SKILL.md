# MCP 路由更新 Skill

## 用途

当 WDP 知识库中的 Skill 发生变更（新增、删除、重命名）时，自动同步更新 MCP 服务器中的路由配置。

## 触发场景

- 知识库中新增 Skill 目录
- 删除现有 Skill 目录
- Skill 功能分类变更
- 需要调整工作流路由映射

## 工作流步骤

### Step 1: 扫描知识库现状

使用 `list_skills` 工具获取当前知识库中所有 Skill 目录：

```json
{
  "tool": "list_skills"
}
```

记录所有包含 `SKILL.md` 的目录名称。

### Step 2: 读取当前路由配置

使用 `get_skill_content` 读取服务器当前的路由配置：

```json
{
  "tool": "get_skill_content",
  "path": "../mcp-knowledge-server/src/server.ts"
}
```

重点关注 `handleStartWdpWorkflow` 函数中的：
- `skill_mapping` 对象
- `examples` 数组
- `MCP_TOOLS[0].description` 中的触发场景

### Step 3: 对比差异

对比知识库现状与路由配置，识别：

| 检查项 | 说明 |
|--------|------|
| **新增 Skill** | 知识库中有，但 `skill_mapping` 中没有 |
| **删除 Skill** | `skill_mapping` 中有，但知识库中没有 |
| **敏感路径** | 是否需要添加到 `SENSITIVE_PATHS` |
| **示例更新** | `examples` 数组是否需要调整 |

### Step 4: 更新路由配置

#### 4.1 更新 `src/server.ts`

在 `handleStartWdpWorkflow` 函数中：

**更新 `skill_mapping` 对象**：
```typescript
skill_mapping: {
  'BIM相关': 'wdp-api-bim-unified/SKILL.md',
  'GIS相关': 'gis-api-core-operations/SKILL.md',
  // ... 其他映射
  '新增分类': 'wdp-api-xxx/SKILL.md',  // <-- 新增
}
```

**更新 `examples` 数组**：
```typescript
examples: [
  { scenario: 'BIM相关', path: 'wdp-api-bim-unified/SKILL.md' },
  // ... 其他示例
  { scenario: '新增场景', path: 'wdp-api-xxx/SKILL.md' },  // <-- 新增
]
```

**更新工具描述**（如新增触发场景）：
在 `MCP_TOOLS[0].description` 中添加新的触发关键词。

#### 4.2 更新敏感路径（如需要）

如果新增 Skill 涉及敏感内容，同步更新：

**`src/utils/tokenManager.ts`**：
```typescript
const SENSITIVE_PATHS = [
  'wdp-internal-case-acquisition',
  'ONLINE_COVERAGE_AUDIT.md',
  'wdp-api-sensitive-xxx',  // <-- 新增
];
```

**`src/mcp-client.ts`**：
```typescript
const SENSITIVE_PATHS = [
  'wdp-internal-case-acquisition',
  'ONLINE_COVERAGE_AUDIT.md',
  'wdp-api-sensitive-xxx',  // <-- 新增（保持同步）
];
```

### Step 5: 验证更新

#### 5.1 语法检查

```bash
cd mcp-knowledge-server
npm run build
```

#### 5.2 功能测试

重启 MCP 服务器后，测试：

```json
{
  "tool": "start_wdp_workflow",
  "arguments": {
    "user_requirement": "测试新增Skill的场景"
  }
}
```

验证返回的 `skill_mapping` 包含新增内容。

#### 5.3 列出所有 Skill

```json
{
  "tool": "list_skills"
}
```

确认新增 Skill 可见。

## 更新检查清单

```
□ 1. 扫描知识库，获取完整 Skill 列表
□ 2. 读取 src/server.ts 当前路由配置
□ 3. 对比识别新增/删除/变更的 Skill
□ 4. 更新 handleStartWdpWorkflow 中的 skill_mapping
□ 5. 更新 handleStartWdpWorkflow 中的 examples 数组
□ 6. 检查并更新 MCP_TOOLS[0].description（如需要）
□ 7. 检查是否需要更新 SENSITIVE_PATHS
□ 8. 同步更新 src/utils/tokenManager.ts
□ 9. 同步更新 src/mcp-client.ts
□ 10. 执行 npm run build 检查语法
□ 11. 重启服务器验证功能
□ 12. 使用 list_skills 确认更新生效
```

## 关键文件路径

| 文件 | 用途 | 更新内容 |
|------|------|----------|
| `src/server.ts` | 主服务器 | `skill_mapping`, `examples`, `MCP_TOOLS` |
| `src/utils/tokenManager.ts` | 权限管理 | `SENSITIVE_PATHS` |
| `src/mcp-client.ts` | 独立客户端 | `SENSITIVE_PATHS` |

## 注意事项

1. **保持同步**: `tokenManager.ts` 和 `mcp-client.ts` 的 `SENSITIVE_PATHS` 必须一致
2. **分类合理**: `skill_mapping` 的键名应该清晰描述 Skill 功能
3. **示例完整**: `examples` 应该覆盖主要使用场景
4. **构建验证**: 每次更新后必须执行 `npm run build` 确保无语法错误
5. **服务重启**: 代码更新后需要重启 MCP 服务器才能生效

## 快速命令参考

```bash
# 构建检查
cd mcp-knowledge-server && npm run build

# 启动服务器（开发模式）
npm run dev

# 查看日志
tail -f logs/access.log
```

## 示例：新增一个 Skill

假设新增 `wdp-api-measurement-tools` Skill：

1. **确认知识库中已存在**: `wdp-api-measurement-tools/SKILL.md`
2. **更新 `src/server.ts`**:
   - 在 `skill_mapping` 添加：`'测量工具': 'wdp-api-measurement-tools/SKILL.md'`
   - 在 `examples` 添加：`{ scenario: '测量工具', path: 'wdp-api-measurement-tools/SKILL.md' }`
3. **检查敏感路径**: 如非敏感，跳过
4. **构建验证**: `npm run build`
5. **重启服务**: 重新启动 MCP 服务器
6. **验证**: 调用 `start_wdp_workflow` 确认新 Skill 在路由中
