# HANDOFF: brain 视觉 P0 — 变化感知 + 按需视觉 + 视觉历史

> Phase 2B-2 已完成（minicpm-v 语义质量提升）。本次 P0 让 brain 从「静态快照」升级到「动态理解」。

---

## 当前状态

- semantic_vision_daemon.py v2：每 15s 用 Ollama minicpm-v 生成中文 rawText → `semantic-latest.json`
- visual-state.ts：3s 轮询 mtime，缓存 VisualState（含 rawText）
- brain-api.ts：`formatEnvironmentHint()` 将 rawText 注入 system prompt
- MCP 工具框架：ToolRegistry + McpServer，已有 search_memory / list_memories / run_diagnosis

## P0 三个子任务

### 子任务 1: 变化感知（semantic daemon 侧）

**目标**：brain 知道「刚发生了什么」，不只是「现在是什么」。

**改动文件**：`tools/vision/semantic_vision_daemon.py`

**实现**：
1. daemon 内存中保留上一次的 `prev_raw_text`（字符串）和 `prev_present`（bool）
2. 每次扫描后，对比当前 vs 上一次，检测变化事件：

| 变化类型 | 检测条件 | 事件标签 |
|---------|---------|---------|
| 人来了 | prev_present=False → present=True | `person_arrived` |
| 人走了 | prev_present=True → present=False | `person_left` |
| 场景变化 | rawText 与 prev_raw_text 相似度低（简单方式：共有词占比 < 50%） | `scene_changed` |

3. 写入 `data/activity/visual-changes.jsonl`（追加，单行 JSON）：
```json
{"ts": "ISO时间", "event": "person_arrived", "detail": "川哥回到工位，穿深色衬衣", "rawText": "当前完整描述"}
```

4. 同时在 `semantic-latest.json` 中新增字段：
```json
{
  "...现有字段...",
  "lastChange": {"event": "person_arrived", "ts": "...", "detail": "..."},
  "prevRawText": "上一次的描述（用于前端对比）"
}
```

5. JSONL 文件保留最近 200 行，超出自动截断。

**关键约束**：
- 相似度计算用 Python 集合交集，不引入 NLP 库
- `prev_raw_text` 初始为空字符串，首次扫描不触发 `scene_changed`
- 人来/人走事件仅依赖 `present` 字段（来自 latest.json 的 MobileNet-SSD），不依赖 rawText

### 子任务 2: 按需视觉问答（brain-api + 新 MCP 工具）

**目标**：用户问「桌上那个红色的是什么」时，用用户的问题当 prompt 立即调一次 minicpm-v，得到针对性回答。

**改动文件**：
- 新建 `src/services/vision-tool.ts` — 按需视觉工具
- 修改 `src/mcp-entry.ts` — 注册新工具
- 修改 `src/brain-api.ts` — 视觉问题检测 + 增强

**实现方案**：

**方案 A（MCP 工具，供外部 Agent 调用）**：

新建 `src/services/vision-tool.ts`：
```typescript
// 工具定义
name: "look_at"
description: "用摄像头回答视觉问题。输入一个关于当前环境的问题，返回基于实时画面的回答。"
inputSchema: { question: z.string().describe("要问的视觉问题") }
isReadOnly: true
timeoutMs: 30000

// execute 实现：
// 1. 读取 data/activity/latest.jpg（最新帧）
// 2. base64 编码
// 3. 调用 Ollama API: POST http://localhost:11434/api/generate
//    { model: "minicpm-v", prompt: question, images: [base64], stream: false, options: { num_predict: 300 } }
// 4. 返回 response 文本
```

在 `mcp-entry.ts` 注册：
```typescript
import { lookAtTool } from "./services/vision-tool.js";
registry.register(lookAtTool);
```

**方案 B（brain-api 内联增强，零延迟路径优先）**：

在 `brain-api.ts` 的 `handleChatCompletions` 中：
1. 检测用户消息是否为视觉问题（关键词：看、穿、桌上、环境、摄像头、画面、附近、什么颜色、拿着）
2. 如果是，且 rawText 已在 system prompt 中 → 不做额外操作（rawText 已足够）
3. 如果是，但 rawText 缺失或过时（>60s）→ 同步调一次 Ollama，用用户问题做 prompt
4. 将即时回答注入到 system prompt 的 environmentHint 尾部：`- 针对你的问题的实时观察: {answer}`

**推荐**：先实现方案 A（MCP 工具），这是最干净的抽象。方案 B 作为后续优化（减少延迟）。

**Ollama 调用封装**：

新建 `src/services/ollama-vision.ts`（共用模块，MCP 工具和 brain-api 都可调用）：
```typescript
export async function askOllamaVision(
  imagePath: string,
  question: string,
  options?: { ollamaUrl?: string; model?: string; timeoutMs?: number }
): Promise<string>
```

- 读取图片文件 → base64
- POST `http://localhost:11434/api/generate`
- 超时 60s
- 返回 response 文本
- 错误时抛异常（调用方决定降级策略）

### 子任务 3: 视觉历史（daemon 写 + visual-state 读 + brain-api 注入）

**目标**：brain context 包含最近 N 次观察，支持「刚才你看到什么了」「我离开了多久」。

**改动文件**：
- `tools/vision/semantic_vision_daemon.py` — 写入历史 JSONL
- `src/services/visual-state.ts` — 缓存最近 N 条历史
- `src/brain-api.ts` — 注入历史摘要

**实现**：

**daemon 写入**：每次成功扫描后，追加一行到 `data/activity/semantic-history.jsonl`：
```json
{"ts": "ISO时间", "present": true, "rawText": "完整描述", "method": "ollama/minicpm-v", "change": "scene_changed"}
```
- `change` 字段：本次检测到的变化事件名，无变化时为 `null`
- 文件保留当天数据（按日期命名：`semantic-history-YYYY-MM-DD.jsonl`）
- 每日自动轮转（新的一天开始写新文件）

**visual-state 读取**：
```typescript
// VisualState 接口新增
readonly recentObservations: readonly VisualObservation[];

interface VisualObservation {
  readonly ts: string;
  readonly present: boolean | null;
  readonly rawText: string;
  readonly change: string | null;
}
```

- `pollOnce()` 中：当 semantic-latest.json 更新时，同时读取 `semantic-history-{today}.jsonl` 最后 5 行
- 缓存为 `recentObservations`（内存中最多 5 条）
- 不需要每次 poll 都读历史文件 — 仅在 semantic mtime 变化时刷新

**brain-api 注入**：
在 `formatEnvironmentHint()` 末尾，如果 `recentObservations.length > 1`：
```
## 最近视觉观察
- 17:45 [在工位] 川哥穿深色衬衣操作电脑...（场景变化）
- 17:30 [在工位] 川哥在看手机...
- 17:15 [离开] 工位无人，桌上有显示器和水杯...
```

仅注入与当前不同的历史条目（去重），最多 3 条，每条截断到 60 字。

---

## 改动文件汇总

| 文件 | 改动类型 | 子任务 |
|------|---------|--------|
| `tools/vision/semantic_vision_daemon.py` | 改：变化检测 + 历史写入 | 1 + 3 |
| `src/services/visual-state.ts` | 改：接口加 recentObservations + lastChange | 1 + 3 |
| `src/services/ollama-vision.ts` | **新建**：Ollama 视觉 API 封装 | 2 |
| `src/services/vision-tool.ts` | **新建**：look_at MCP 工具 | 2 |
| `src/mcp-entry.ts` | 改：注册 look_at 工具 | 2 |
| `src/brain-api.ts` | 改：formatEnvironmentHint 注入变化事件 + 历史 | 1 + 3 |

## 不要改的文件

- `tools/vision/vision_daemon.py` — 底层摄像头 daemon 不动
- `src/services/visual-gate.ts` — 门控规则不动
- `src/server.ts` — 路由不动

---

## 实现顺序（建议）

1. **子任务 1: 变化感知**（daemon 侧，Python）
   - 改 semantic_vision_daemon.py：加 prev 对比 + 写 visual-changes.jsonl + semantic-latest.json 加 lastChange
   - 改 visual-state.ts：接口加 lastChange，applySemanticSnapshot 读取
   - 改 brain-api.ts：formatEnvironmentHint 注入最近变化
   - 验证：semantic-latest.json 里有 lastChange，brain 回答「刚才发生了什么」能说出变化

2. **子任务 3: 视觉历史**（与子任务 1 共享 daemon 改动）
   - 改 semantic_vision_daemon.py：写 semantic-history-YYYY-MM-DD.jsonl
   - 改 visual-state.ts：加 recentObservations + 读取历史
   - 改 brain-api.ts：注入最近观察
   - 验证：brain 回答「最近看到什么了」能引用历史观察

3. **子任务 2: 按需视觉**（TS 侧新建模块）
   - 新建 ollama-vision.ts：Ollama API 封装
   - 新建 vision-tool.ts：look_at MCP 工具
   - 改 mcp-entry.ts：注册
   - 验证：通过 MCP 调用 look_at 工具能返回实时画面描述

---

## Studio 环境

| 项目 | 值 |
|------|-----|
| Ollama API | `http://localhost:11434` |
| minicpm-v | 已就绪 |
| Python venv | `~/mycc-brain/tools/vision/.venv-vision/` |
| brain PM2 | `npx pm2 restart brain` |
| TS build | `export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain && npx tsc` |
| 部署 | Air rsync → Studio |

### rsync 命令模板

```bash
# Python daemon
rsync -avz tools/vision/semantic_vision_daemon.py studio:~/mycc-brain/tools/vision/

# TS 源码
rsync -avz src/services/visual-state.ts src/services/ollama-vision.ts src/services/vision-tool.ts studio:~/mycc-brain/src/services/ && \
rsync -avz src/brain-api.ts src/mcp-entry.ts studio:~/mycc-brain/src/

# Studio build + restart
ssh studio 'export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain && npx tsc && npx pm2 restart brain'

# 重启 semantic daemon
ssh studio 'kill $(ps aux | grep semantic_vision | grep -v grep | awk "{print \$2}") 2>/dev/null; sleep 1; cd ~/mycc-brain && nohup tools/vision/.venv-vision/bin/python3 tools/vision/semantic_vision_daemon.py --data-dir data/activity --debug > data/activity/semantic-daemon.log 2>&1 &'
```

---

## 验收标准

### 子任务 1: 变化感知
1. `cat data/activity/visual-changes.jsonl` 有事件记录
2. `cat data/activity/semantic-latest.json | jq .lastChange` 非 null（场景有变化时）
3. 在 Admin UI 问「刚才发生了什么」能得到变化事件描述

### 子任务 2: 按需视觉
4. MCP 工具列表中出现 `look_at`
5. 调用 `look_at { question: "桌上有什么" }` 返回具体描述
6. `npm run build` 通过

### 子任务 3: 视觉历史
7. `cat data/activity/semantic-history-2026-04-08.jsonl | tail -5` 有最近观察记录
8. 在 Admin UI 问「最近你看到什么了」能引用多条历史观察
9. `python3 -m py_compile semantic_vision_daemon.py` 通过

---

## 禁止

- 不引入新的 Python 依赖（相似度用集合运算）
- 不引入新的 npm 依赖
- 不改 vision_daemon.py / visual-gate.ts / server.ts
- 不做人脸识别 / ASR
- 历史文件不超过当天（不做跨天查询）
- look_at 工具超时不超过 60s

---

*创建时间：2026-04-08*
*规划人：cc (Claude claude-opus-4-6)*
