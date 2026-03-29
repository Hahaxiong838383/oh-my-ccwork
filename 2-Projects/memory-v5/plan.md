# v5 升级详细设计

> 所有改动都在 `.claude/skills/mycc/scripts/src/services/` 下。
> 每项改动独立可验证，失败时回退到 v4 逻辑。

---

## P0-1：RRF 融合评分

**文件**：`context-loader.ts`
**函数**：`hybridMatchCategories()`

### 现状

```typescript
// 三路检索结果简单合并去重
const allCats = new Set([...keywordCats, ...tfidfCats, ...vectorCats])
```

### 升级

三路检索各自产出**排名列表**，用 RRF 统一评分：

```typescript
// RRF 公式：score(cat) = Σ 1/(k + rank_i)，k=60
const RRF_K = 60

function rrfFuse(rankedLists: { category: string, rank: number }[][]): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of rankedLists) {
    for (const { category, rank } of list) {
      const prev = scores.get(category) || 0
      scores.set(category, prev + 1 / (RRF_K + rank))
    }
  }
  return scores  // 按 score 降序取 Top N
}
```

**改动点**：
1. `KEYWORD_CATEGORY_MAP` 匹配结果附带 rank（匹配顺序）
2. `fuzzyMatchCategories()` 返回 `{category, tfidfScore}` → 按 score 排序得 rank
3. `vectorMatchCategories()` 返回 `{category, avgCosine}` → 按 cosine 排序得 rank
4. 三路 rankedLists 喂入 `rrfFuse()`，取 RRF score 最高的 N 个类别

**降级**：向量路不可用时，只有两路参与 RRF，公式不变。

**验证方法**：
```bash
# 在飞书发一条消息，检查 trajectories/ 下的召回日志
# 对比 v4 和 v5 的命中类别差异
```

---

## P0-2：检索轨迹

**文件**：`context-loader.ts`
**函数**：`loadSharedContext()` / `loadSharedContextLight()`

### 设计

```typescript
interface RetrievalTrace {
  timestamp: string           // ISO 时间
  query: string               // 用户消息（脱敏截断到 100 字）
  pipeline: {
    keyword: { matched: string[], ranks: number[] }
    tfidf: { matched: string[], scores: number[] }
    vector: { matched: string[], cosines: number[], available: boolean }
  }
  rrf: { category: string, score: number }[]  // RRF 融合后排名
  injected: {
    category: string
    itemCount: number
    topItem: string           // 最高分条目（截断到 80 字）
    topScore: number
  }[]
  budget: { used: number, limit: number }  // token 消耗
}
```

**写入位置**：`0-System/trajectories/recall-YYYY-MM-DD.jsonl`
- 每行一条 JSON，按天滚动
- 7 天后自动清理（主动遗忘同机制）

**用途**：
1. 调试：用户说"你怎么不知道 XX"→ 查轨迹看是否命中
2. insights 分析：统计哪些类别经常不命中 → 反哺关键词映射表

**降级**：写入失败静默跳过，不影响注入。

---

## P0-3：会话过滤

**文件**：`chat-memory.ts`
**函数**：入口处（`recordConversationTurn()` 或 `buildCrossSessionContext()`）

### 设计

```typescript
const IGNORE_SESSION_PATTERNS = [
  "scheduler:*",          // 定时任务产出
  "group:*:broadcast",    // 群广播
  "cron:*",               // 定时消息
]

function shouldPersistSession(sessionId: string): boolean {
  return !IGNORE_SESSION_PATTERNS.some(pattern =>
    globMatch(sessionId, pattern)
  )
}

// globMatch: * 匹配非冒号字符，** 匹配任意字符（含冒号）
```

**改动点**：
1. `recordConversationTurn()` 入口加 `if (!shouldPersistSession(sessionId)) return`
2. `onSessionEnd()` 同理跳过

**验证**：定时任务执行后检查 `chat-memory/` 不新增对应文件。

---

## P1-4：L0/L1/L2 渐进加载

**文件**：`context-loader.ts`（注入逻辑）+ 新脚本生成 L0/L1

### 三层定义

| 层级 | 内容 | token 预算 | 存储 |
|------|------|-----------|------|
| L0 | 每个类别一句话："[project/技术-飞书] 12 条记忆，涉及签名算法、卡片 API、错误码" | ~20 token/类别 | `memory-items.md` 各类别首行注释 |
| L1 | Top 3 高分 Item 拼接 | ~200 token/类别 | 从 L2 实时计算（不额外存储） |
| L2 | Top 10 条完整内容 | 当前注入量 | 现有逻辑不变 |

### 注入策略变更

```
v4：匹配到类别 → 直接注入 L2（Top 10）

v5：
1. 始终注入所有类别的 L0（~400 token 总开销）  ← 新增
2. 匹配到的类别 → 注入 L1（Top 3 摘要）         ← 新增中间层
3. 强匹配（RRF score > 阈值）→ 注入 L2（Top 10） ← 现有逻辑
```

**关键收益**：L0 让 cc 知道"存在飞书相关记忆"，即使关键词没精确命中，也能在需要时主动查询。

### L0 生成

在 `rebuild-index.ts` 或新增定时任务中：

```typescript
// 为每个类别生成一行 L0 摘要
function generateL0(category: string, items: string[]): string {
  const keywords = extractTopKeywords(items, 5)  // TF-IDF 提取 Top 5 关键词
  return `[${category}] ${items.length} 条：${keywords.join('、')}`
}
```

不需要 LLM（区别于 OpenViking 用 LLM 生成），纯统计方法 + 模板即可。

---

## P1-5：scope 扩展

**文件**：`memory-items.md` + `context-loader.ts`

### 新增两个 scope

```markdown
## [agent/技能]
- cc 学到的操作技能和已验证的模式
- 来源：evolution-log 已毕业规则
- 示例：调试服务错误前必须先跑 5 步检查

## [agent/踩坑]
- 已踩过的坑和修复方法
- 来源：Bug-Fix 中的高频复用条目
- 与 [project/Bug-Fix] 的区别：agent/* 是跨项目通用的教训

## [session/当前]
- 当前会话中捕获的临时事实
- 会话结束时清理或提升到 [project/*]
```

### 注入策略

| scope | 注入策略 |
|-------|---------|
| `[user/*]` | 始终注入（不变） |
| `[agent/*]` | 始终注入（cc 的技能记忆，每次都有用） |
| `[project/*]` | 关键词/RRF 匹配（不变） |
| `[session/*]` | 当前会话内自动注入，跨会话不注入 |

### 迁移

从现有数据迁移：
1. `evolution-log.md` 已毕业规则 → `[agent/技能]`
2. `[project/Bug-Fix]` 中跨项目通用的条目 → `[agent/踩坑]`
3. `chat-memory` per-chat facts → `[session/当前]`（新写入走这里）

---

## P2-6：DAG 对话摘要

**文件**：`chat-memory.ts`

### 现状

```typescript
// onSessionEnd() 生成扁平摘要
const summary = await llm.summarize(allMessages)
saveSummary(chatId, summary)  // 一坨文本，不可展开
```

### 升级

```typescript
interface DAGNode {
  id: string
  level: number              // 0=叶子, 1=中间, 2+=根
  sourceRange: [number, number]  // 消息序号范围
  summary: string            // 摘要文本
  children: string[]         // 子节点 ID（叶子节点为空）
  tokenCount: number
}

interface ConversationDAG {
  chatId: string
  nodes: DAGNode[]
  rootId: string
}
```

### 压缩流程

```
触发条件：消息数 > freshTailCount（32）且 context 占比 > 0.75

1. 取最老的 N 条消息（排除尾部 32 条）
2. 按 ~20k token 分组 → 各生成叶子摘要（~1200 token）
3. 叶子数 ≥ 2 → 合并生成中间摘要（~2000 token）
4. 递归直到只有一个根节点
```

### expand 回溯

```typescript
// Agent 可调用的回溯接口
function expand(nodeId: string): { summary: string, children: DAGNode[] }
// 从根 → 中间 → 叶子 → 可定位到原始消息范围
```

### 存储

`chat-memory/{chatId}.json` 从 `{ summary: string }` 升级为 `ConversationDAG`。

**改动量大**，建议独立分支开发。

---

## P2-7：LLM 重排

**文件**：`context-loader.ts`

### 设计

在 MMR 选出 Top 10 后，增加一个阶段：

```typescript
async function llmRerank(query: string, items: ScoredItem[]): Promise<ScoredItem[]> {
  // 用 Ollama 运行 Qwen3-Reranker-0.6B
  // 输入：query + 每条 item
  // 输出：相关性分数 0-1
  // 最终分数 = 0.6 * rerankScore + 0.4 * originalScore
}
```

**降级**：Ollama 不可用 → 跳过重排，直接用 MMR 结果。

**前提**：需要 `ollama pull qwen3-reranker:0.6b`（~640MB）。

---

## 版本号规划

| 阶段 | 版本 | 内容 |
|------|------|------|
| P0 完成 | v4.5 | RRF + 轨迹 + 过滤 |
| P1 完成 | v5.0 | + L0/L1/L2 + scope 扩展 |
| P2 完成 | v5.5 | + DAG 摘要 + LLM 重排 |
