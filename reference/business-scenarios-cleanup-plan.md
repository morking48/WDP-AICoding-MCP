# business-scenarios 旧版引用清理计划

> 基于远程 Skill Server (wdpapi-skill.51aes.com) 最新 API 对齐分析

---

## 一、新旧 API 对照表

| 旧版（场景文件中） | 新版（Skill Server 实际 API） | 说明 |
|-------------------|------------------------------|------|
| `App.Scene.Creates` | `new App.Xxx({...})` + `App.Scene.Add(entity)` | 批量创建不存在，逐实体构造+Add |
| `RegisterSceneEvent({ events: [...] })` | `RegisterSceneEvent(name, func)` 或 `RegisterSceneEvents(handlers)` | 签名变化，单事件/multi 分开 |
| `App.CameraControl.Focus` | `App.CameraControl.FlyTo()` 或 `SetCameraPose()` | Focus 不存在 |
| `App.CameraControl.Follow` | `App.CameraControl.UpdateCamera()` 或 `PlayEntityRoam()` | Follow 不存在 |
| `App.CameraControl.FocusByCustomId` | `App.CameraControl.SetCameraPose({...})` | 需查 camera-control SKILL.md 确认 |
| `App.CameraControl.FocusByLocation` | `App.CameraControl.SetCameraPose({...})` 或 `FlyTo()` | 同上 |
| `poiStyle.text` | `labelContent` 数组（如 `['文本', '#FFFFFFFF', 14]`） | 字段名变化 |
| `poiStyle.textStyle` | 合并到 `labelContent` 数组第2-3项 | 字段名变化 |
| `poiStyle.markerSelectUrl` | `markerActivateUrl` | 字段名变化 |
| `particleStyle.scale` | `scale3d` 数组 `[sx, sy, sz]` | 类型从 number → 数组 |
| `windowStyle.followEntity` | Window SKILL.md 中无此字段 | 不存在 |
| `OnBoundMoveEnd` | `OnMoveAlongPathEndEvent` | 事件名变化 |

---

## 二、逐文件问题清单

### 1. video-perimeter-monitoring.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 58 | `App.Scene.Creates` in modules | 🔴 |
| 91 | `App.Renderer.RegisterSceneEvent` (旧签名) in modules | 🔴 |
| 100-101 | `App.CameraControl.FocusByCustomId` / `FocusByLocation` | 🔴 |
| 110 | `api: "App.Scene.Creates"` in api_flow step 1 | 🔴 |
| 153 | `api: "App.Renderer.RegisterSceneEvent"` (旧签名 params) | 🔴 |
| 166 | `api: "App.CameraControl.FocusByCustomId"` | 🔴 |
| 179 | `"entity": "new App.Window()"` → 应为 `new App.Window({...})` | 🟡 |
| 194 | `"App.Scene.Creates"` in data_flow | 🔴 |
| 206 | `"App.Scene.Creates(POI)"` in cleanup_chain | 🔴 |
| 67 | `"poiStyle.markerSelectUrl"` → `markerActivateUrl` | 🟡 |
| 67 | `"poiStyle.text"` → `labelContent` | 🟡 |

### 2. ai-robot-inspection.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 113 | `App.Scene.Creates` in modules | 🔴 |
| 121 | `api: "App.Scene.Creates"` in api_flow step 1 | 🔴 |
| 185 | `api: "App.Renderer.RegisterSceneEvent"` (旧签名) | 🔴 |
| 189 | `"OnBoundMoveEnd"` → `OnMoveAlongPathEndEvent` | 🔴 |
| 245 | `"App.Scene.Creates(Path)"` in cleanup_chain | 🔴 |
| 41-53 | `pre_discovery` 整段（旧 context-memory 残留） | 🟡 |
| 75 | `"particleStyle.scale"` → `scale3d` | 🟡 |
| 104 | `"windowStyle.followEntity"` → 不存在 | 🟡 |

### 3. emergency-command.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 108 | `App.Scene.Creates` in modules | 🔴 |
| 114 | `FocusByLocation` | 🔴 |
| 115 | `FocusByCustomId` | 🔴 |
| 124 | `api: "App.Scene.Creates"` in api_flow step 1 | 🔴 |
| 154 | `api: "App.Scene.Creates"` in step 2 | 🔴 |
| 172 | `api: "App.Scene.Creates"` in step 3 | 🔴 |
| 211 | `api: "App.CameraControl.FocusByLocation"` | 🔴 |
| 239-240 | `RegisterSceneEvent` + `OnBoundMoveEnd` | 🔴 |
| 266 | `"App.Scene.Creates"` in data_flow | 🔴 |
| 278 | `"App.Scene.Creates(POI/Range)"` in cleanup | 🔴 |
| 282 | `"App.Scene.Creates(Particle)"` in cleanup | 🔴 |
| 99 | `"windowStyle.followEntity"` | 🟡 |
| 62 | `"particleStyle.scale"` → `scale3d` | 🟡 |

### 4. fire-alert-incident.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 87 | `App.CameraControl.Focus` | 🔴 |
| 94 | `App.Renderer.RegisterSceneEvent` (旧签名) | 🟡 |
| 105 | `api: "App.Renderer.RegisterSceneEvent"` params 格式错误 | 🔴 |
| 135 | `api: "App.Renderer.RegisterSceneEvent"` params 格式错误 | 🔴 |
| 151 | `api: "App.CameraControl.Focus"` | 🔴 |
| 153 | `fallback: "App.CameraControl.SetCameraPose"` → SetCameraPose 是正确 API | 🟢 |

### 5. forest-fire-command-dispatch.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 95 | `App.CameraControl.Focus` | 🔴 |
| 114 | `api: "App.Scene.Creates"` | 🔴 |
| 144 | `api: "App.Scene.Creates"` | 🔴 |
| 163 | `api: "App.Scene.Creates"` | 🔴 |
| 201 | `api: "App.CameraControl.FocusByLocation"` | 🔴 |
| 229 | `api: "App.Renderer.RegisterSceneEvent"` + `OnBoundMoveEnd` | 🔴 |
| 256 | `"App.Scene.Creates"` in data_flow | 🔴 |
| 267-268 | `"App.Scene.Creates"` in cleanup | 🔴 |

### 6. scenic-shuttle-monitoring.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 88 | `App.CameraControl.Focus` | 🔴 |
| 96 | `App.Renderer.RegisterSceneEvent` (旧签名) | 🟡 |
| 107 | `api: "App.Renderer.RegisterSceneEvent"` params 格式错误 | 🔴 |
| 143 | `api: "App.Renderer.RegisterSceneEvent"` params 格式错误 | 🔴 |
| 158 | `api: "App.CameraControl.Focus"` | 🔴 |

### 7. grid-management-inspection.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 96 | `App.CameraControl.FocusByLocation` | 🟡 |
| 103 | `App.Renderer.RegisterSceneEvent` | 🟡 |
| 105 | `OnBoundMoveEnd` → `OnMoveAlongPathEndEvent` | 🔴 |
| 168 | `step 4: entity: "new App.Bound()"` → 需加 `({...})` | 🟡 |
| 186-194 | `RegisterSceneEvent` + `OnBoundMoveEnd` | 🔴 |

### 8. ai-dog-patrol-combo.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 99 | `App.CameraControl.Follow` | 🔴 |
| 110 | `App.Renderer.RegisterSceneEvent` (旧签名) | 🟡 |
| 211 | `RegisterSceneEvent` params 格式 | 🟡 |
| 224 | `App.CameraControl.Follow` | 🔴 |
| 282 | cleanup 中 `App.CameraControl.Follow` → `停止跟随` | 🔴 |

### 9. bim-building-exploration.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 44-55 | `pre_discovery` 整段（旧 context-memory 残留） | 🟡 |
| 69 | `App.CameraControl.SetCameraPose` → ✅ 正确 | 🟢 |
| 76 | `App.Bim.Split` → 文件自带 ⚠ 警告标注 | 🟡 |
| 83 | `App.Bim.Highlight` → 文件自带 ⚠ 标注真实为 `entity.SetNodeHighLight` | 🟡 |

### 10. scene-environment-control.json

| 检查 | 结果 |
|------|------|
| `App.Scene.SetWeather` | ✅ 已在 SKILL.md 确认（environment/SKILL.md） |
| `App.Scene.SetTime` | ✅ 同上 |
| `App.Scene.SetDark` | ✅ 同上 |

### 11. camera-viewshed-analysis.json

| 行 | 问题 | 严重度 |
|----|------|--------|
| 52 | `new App.Camera()` → 需查 camera-control SKILL.md 确认 | 🟡 |
| 60-61 | `camera.SetFOV` / `camera.SetDistance` → 需确认是否存在于新版 | 🟡 |

---

## 三、按问题类型统计

| 问题类型 | 受影响文件数 | 出现次数 |
|---------|-------------|---------|
| `App.Scene.Creates` | 4 | 18 |
| `RegisterSceneEvent` 旧签名 | 8 | 16 |
| `Focus` / `Follow` （不存在的相机 API） | 4 | 7 |
| `FocusByCustomId` / `FocusByLocation` | 3 | 6 |
| `OnBoundMoveEnd` → `OnMoveAlongPathEndEvent` | 5 | 7 |
| `poiStyle` 字段名过时 | 1 | 2 |
| `particleStyle.scale` → `scale3d` | 2 | 2 |
| `windowStyle.followEntity`（不存在） | 2 | 2 |
| `pre_discovery` 残留 | 2 | 2 |
| `new App.Camera()` + `SetFOV/SetDistance`（待验证） | 1 | 3 |
| `App.Bim.Split/Highlight`（已有 ⚠ 标注） | 1 | 2 |

---

## 四、执行计划

### Phase 1: 需要先验证的 API（拉取远程 Skill 确认）

| API | 文件 | 状态 |
|-----|------|------|
| `environment/SKILL.md` — SetWeather/SetTime/SetDark | scene-environment-control.json | ✅ 已确认 |
| `camera-control/SKILL.md` — `new App.Camera()` 是否存在 | camera-viewshed-analysis.json | 🔲 待确认 |
| `camera-control/SKILL.md` — `camera.SetFOV` / `camera.SetDistance` | camera-viewshed-analysis.json | 🔲 待确认 |

### Phase 2: 逐文件重写（按优先级）

| 优先级 | 文件 | 改动范围 |
|--------|------|---------|
| 🔴 P0 | video-perimeter-monitoring.json | modules + api_flow + data_flow + cleanup |
| 🔴 P0 | ai-robot-inspection.json | modules + api_flow + data_flow + cleanup + 删除 pre_discovery |
| 🔴 P0 | emergency-command.json | modules + api_flow + data_flow + cleanup |
| 🔴 P0 | fire-alert-incident.json | modules + api_flow |
| 🔴 P0 | forest-fire-command-dispatch.json | modules + api_flow + data_flow + cleanup |
| 🔴 P0 | scenic-shuttle-monitoring.json | modules + api_flow |
| 🔴 P0 | grid-management-inspection.json | modules + api_flow |
| 🔴 P0 | ai-dog-patrol-combo.json | modules + api_flow + cleanup |
| 🟡 P1 | bim-building-exploration.json | 删除 pre_discovery |
| 🟡 P2 | camera-viewshed-analysis.json | 待验证后修改 |

---

## 五、额外发现（非 API 但影响质量）

1. **`_index.json` primary_skills/secondary_skills 路径**：全部使用 `reference/scene/covering/...`（单数 scene），与远程 Skill Server 路径一致 ✅
2. **`scene-environment-control.json` primary_skills 和 secondary_skills 为空数组**：这是正确的（环境控制是全局单例 setter，不属于覆盖物/模型类 Skill）
3. **`bim-building-exploration.json` 已自带 ⚠ 警告标注**：说明之前有人发现过 App.Bim.Split/Highlight 不存在的问题

---

## 六、验证状态

| 步骤 | 状态 |
|------|------|
| 拉取远程 manifest（212 个文件） | ✅ |
| 确认 factory-api.md / object-base.md 存在及 API 签名 | ✅ |
| 拉取 POI SKILL.md 确认字段名 | ✅ |
| 拉取 Renderer SKILL.md 确认事件 API | ✅ |
| 拉取 CameraControl SKILL.md 确认 FlyTo/SetCameraPose 等 | ✅ |
| 拉取 Window SKILL.md 确认字段 | ✅ |
| 拉取 Environment SKILL.md 确认 SetWeather/SetTime/SetDark | 🔲 待完成 |
| 确认 Camera 实体 API (SetFOV/SetDistance) | 🔲 待完成 |