# HANDOFF — 记忆系统三大优化

## 已完成 ✅

### Phase 0: 回滚安全网
- `services/memory-rollback.ts` — 快照/回滚/质量门/自动回滚（~170 行）
- `0-System/memory-config.json` — 功能开关（全部默认关闭）
- `0-System/snapshots/` — 快照目录（已 gitignore）
- `.gitignore` — 已加 `0-System/snapshots/`

### Phase 3: Agent 独立记忆
- `services/agent-memory.ts` — 加载/记录/裁剪/去重/批量提取（~200 行）
- `0-System/agent-memory/cc.md` — cc 引擎经验
- `0-System/agent-memory/codex.md` — codex 引擎经验
- `0-System/agent-memory/gemini.md` — gemini 引擎经验

### 分析文档
- `2-Projects/cc-source-analysis/architecture-analysis.md` — 四维度分析
- `2-Projects/cc-source-analysis/README.md` — 项目索引

## 已完成 ✅（Phase 1+2）

### Phase 1: Dream 记忆巩固
- `services/dream-consolidation.ts` — 七步流水线（~230 行）
- `index.ts` — executeTask 加 `task.skill === "dream"` 快捷路径
- `tasks.md` — 加 `| 04:00 | 记忆巩固 | dream |` 行

### Phase 2: Session Memory 自动提取
- `services/session-memory.ts` — extractFromSession + extractFromRecentEvents（~170 行）
- `chat-memory.ts` — onSessionEnd 末尾加 fire-and-forget 提取
- `http-server.ts` — 加 4 个端点（snapshots/rollback/extract-session/dream）

### 功能开关
- `memory-config.json` — 三个功能全部开启（sessionExtraction/dreamConsolidation/agentMemory）

## ~~待完成~~ 全部完成 ✅

### ~~Phase 1: Dream 记忆巩固~~（最复杂，~350 行）

新建 `services/dream-consolidation.ts`，需要：
1. **读取现有代码**（必须先做）：
   - `memory-db.ts` 的 `syncAll()` 和 meta 表操作
   - `scheduler.ts` 的 `parseTasks()` 格式
   - `index.ts` 的 `executeTask()` 分支添加
   - `context-loader.ts` 的 `temporalDecay()` 和残差链解析
2. **实现七步流水线**：snapshot → delta 合并 → 归档 → RECENT_EVENTS 清理 → 向量重建 → SQLite 同步 → 质量门
3. **调度集成**：`tasks.md` 加 `| 04:00 | 记忆整理 | dream |`
4. **index.ts 加分支**：`if (task.skill === "dream") { ... }`

### Phase 2: Session Memory 自动提取（中等，~250 行）

新建 `services/session-memory.ts`，需要：
1. **读取现有代码**（必须先做）：
   - `chat-memory.ts` 的 `onSessionEnd()` 位置（约 L256）和 DAG 结构
   - `auto-capture.ts` 的 `runCliEngine()` 模式和 prompt 模板
   - `http-server.ts` 的 URL 路由块（约 L257）
2. **实现提取逻辑**：检查 flag → DAG token > 200 → snapshot → Codex 提取 → 索引同步 → 质量门
3. **两条触发路径**：
   - `chat-memory.ts` 的 `onSessionEnd()` 末尾追加调用
   - `http-server.ts` 新增 `POST /memory/extract-session` 端点
4. **CLI Stop Hook**：`.claude/settings.json` 加 `hooks.Stop`

### http-server.ts 共用修改（Phase 1+2 都需要）

加 3 个端点（约 +30 行）：
- `GET /memory/snapshots` → `listSnapshots(cwd)`
- `POST /memory/rollback` → `rollbackToSnapshot(cwd, body.snapshot)`
- `POST /memory/extract-session` → `extractFromRecentEvents(cwd)`
- `POST /memory/dream` → `runDream(cwd)`（手动触发）

## 关键文件路径

| 文件 | 用途 |
|------|------|
| `.claude/skills/mycc/scripts/src/services/memory-rollback.ts` | ✅ 回滚安全网 |
| `.claude/skills/mycc/scripts/src/services/agent-memory.ts` | ✅ Agent 独立记忆 |
| `.claude/skills/mycc/scripts/src/services/dream-consolidation.ts` | 🔲 待创建 |
| `.claude/skills/mycc/scripts/src/services/session-memory.ts` | 🔲 待创建 |
| `.claude/skills/mycc/scripts/src/services/memory-db.ts` | 需读取，了解 syncAll/meta |
| `.claude/skills/mycc/scripts/src/services/chat-memory.ts` | 需修改 onSessionEnd |
| `.claude/skills/mycc/scripts/src/services/auto-capture.ts` | 参考 runCliEngine 模式 |
| `.claude/skills/mycc/scripts/src/http-server.ts` | 需修改，加端点 |
| `.claude/skills/mycc/scripts/src/index.ts` | 需修改，加 dream 分支 |
| `skills/scheduler/tasks.md` | 需加 04:00 dream 条目 |
| `0-System/memory-config.json` | ✅ 功能开关 |
| `.claude/plans/drifting-drifting-sunrise.md` | 完整实施方案 |

## 衔接提示词

```
继续实施记忆系统三大优化的 Phase 1 和 Phase 2。

HANDOFF 在 2-Projects/cc-source-analysis/HANDOFF.md，完整方案在 .claude/plans/drifting-drifting-sunrise.md。

Phase 0（回滚安全网）和 Phase 3（agent-memory）已完成。现在需要：

1. 先读取 memory-db.ts、chat-memory.ts、auto-capture.ts、http-server.ts、index.ts 这 5 个文件
2. 实施 Phase 1: dream-consolidation.ts（04:00 自动记忆巩固）
3. 实施 Phase 2: session-memory.ts（session 结束自动提取）
4. 修改 http-server.ts 加 4 个端点
5. 修改 chat-memory.ts 的 onSessionEnd 加提取调用
6. 所有自动写入必须先 createSnapshot()，写后 postWriteGuard()

memory-config.json 所有功能默认关闭，完成后逐个开启测试。
```
