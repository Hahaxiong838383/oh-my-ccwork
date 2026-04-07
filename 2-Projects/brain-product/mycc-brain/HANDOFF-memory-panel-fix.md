# 交接文档：记忆面板「最近写入」时间修复

## 问题

Admin UI 记忆面板显示「最近写入: 2026-04-03」，但 brain intake 在 4月7日 有正常写入。

## 根因

两层问题：

### 1. 数据层
- `memory-items.md`（Air cc 写入）：4月3日后没更新 — Air 的 cc session 写入的是 `.claude/projects/*/memory/*.md`，不是 `0-System/memory-items.md`
- `memory-items-intake.md`（brain 自己写入）：4月7日正常更新
- Studio 上两个文件都在 `/Users/fu-121/mycc-data/0-System/`

### 2. API 层（显示 bug）
- 记忆面板的「最近写入」只读 `memory-items.md` 的时间戳
- 不看 `memory-items-intake.md`
- 应该取两个文件中更新的那个时间

## 修复方向

### 修复 1：memory-health API
**文件**：`src/services/experience-stream.ts` 的 `getMemoryHealth()` 函数

找到计算「最近写入」日期的逻辑，改为同时检查：
- `memory-items.md` 的文件修改时间
- `memory-items-intake.md` 的文件修改时间
- 取两者中更新的

### 修复 2：前端记忆面板
**文件**：`src/admin/admin-ui.html`

- `#mLastWrite` 元素（行 415）显示的日期来自 `/admin/api/memory-health` API
- 确认前端正确读取了修复后的 API 返回值

### 修复 3：记忆条目列表
记忆面板下方的条目列表可能也只读 `memory-items.md`（通过 `parseMemoryItems` API），需要确认是否合并了 intake 文件。

检查 `server.ts` 中 `/admin/api/memory` 相关路由，确保返回合并后的数据。

## 关键文件

| 文件 | 改动 |
|------|------|
| `src/services/experience-stream.ts` | `getMemoryHealth()` 加入 intake 文件时间戳 |
| `src/admin/admin-ui.html` | 确认前端正确显示 |
| `src/server.ts` | 检查 memory 相关 API 是否合并 intake |

## Studio 文件时间戳参考

| 文件 | 修改时间 | 说明 |
|------|---------|------|
| `memory-items.md` | Apr 3 17:25 | Air cc 写入，4月3日后停更 |
| `memory-items-intake.md` | Apr 7 07:15 | brain intake 正常写入 |
| `RECENT_EVENTS.md` | Apr 6 18:18 | 正常同步 |
| `user-profile.md` | Apr 2 22:59 | 静态画像 |

## 部署

修改后用 `bash deploy.sh` 部署，记忆面板应显示 `2026-04-07`。

## 回滚点

- 当前版本：commit `64ae623`（进化闭环激活）
- Admin UI v2.2：commit `6713158`
