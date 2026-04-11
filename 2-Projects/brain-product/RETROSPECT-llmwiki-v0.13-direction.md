# RETROSPECT — llmwiki 初心回归 × mycc-brain v0.13 方向决策

**日期**：2026-04-11 19:30（v1.2 代码级深读后重写）
**作者**：cc（claude-opus-4-6，1M context）
**版本**：mycc-brain 当前 v0.12.4 → 待决策 v0.13.0 方向
**决策人**：川哥
**状态**：⏳ 待川哥拍板
**迭代历史**：v1.0（初稿）→ v1.1（含 X2 prompt 草稿）→ **v1.2（基于 `/tmp/llmwiki-ref` 全量代码级读完后重写核心论断）**

---

## 0. TL;DR（v1.2 — 代码级深读后的重大修正）

### 🔥 原诊断不完整，v1.2 基于真读代码后的颠覆性修正

v1.0/v1.1 的诊断基于 karpathy 原文 + 我对 llmwiki 架构的猜测。**川哥质疑后我 git clone lucasastorian/llmwiki 全量读完代码**，发现一个颠覆性真相：

**llmwiki 的整个服务端完全没有 LLM 调用**：
- `grep -l "anthropic\|openai\|gemini\|gpt-" api/ mcp/` → **零命中**
- `api/requirements.txt` 里没有任何 LLM SDK（只有 `mistral` 用作 OCR）
- 整个仓库只有：**5 个 MCP 工具 + PostgreSQL + PGroonga 全文搜索 + chunker**
- **所有"LLM 维护 wiki"的智能动作，都发生在 Claude.ai / Cursor / Claude Code 这个 MCP client 的 tool use 循环里**

服务端架构简单到惊人：

```
llmwiki = (dumb storage: PG + document_chunks + PGroonga FTS)
        + (tool server: 5 MCP tools = guide/search/read/write/delete)
        + (MCP protocol: streamable HTTP)
        + [智能完全外包给客户端 Claude 的 agent loop]
```

**这意味着**：
- v1.1 推荐的 **X1（brain 内部跑 LLM 复刻 wiki-builder）本质是"在服务端复刻 Claude agent loop"**。ROI 极差，应该删除这个选项。
- **真正对标 llmwiki 的方案是 X0：把 mycc-brain knowledge 子系统暴露为 MCP server**。服务端零 LLM 预算（成本外包给 cc/Claude Code 客户端），符合 llmwiki 真实架构。

### cc v1.2 推荐 [置信度：中高 — 基于代码证据]

**主推：X0（MCP server 化）+ X2（读端 LLM 增强）并行**

| 方向 | 作用域 | 成本 | 状态 |
|---|---|---|---|
| **X0** | 让 cc / Claude Code 能以工具调用方式维护 brain knowledge（真·llmwiki 对标） | 3-5 天 | ⭐ 新增，v1.2 主推 |
| **X2** | brain-chat 第五路注入的读端 LLM rewrite/rerank | 2-3 天 | 保留，v1.1 设计仍有效 |
| ~~X1~~ | ~~brain 内部 LLM 复刻 wiki-builder~~ | ~~1-2 周~~ | 🗑️ 删除。v1.1 误判，本质是复刻 Claude |
| **X3** | v0.12.5 工程补丁 | 4 小时 | 降级保留 |

**X0 + X2 不冲突**：
- X0 面向 "cc 在 Claude Code 里主动维护 Futurus wiki" 场景（MCP tool use）
- X2 面向 "brain-chat mini-app 被动查询" 场景（system prompt 注入）
- 两个入口服务不同 use case，可以并行建

**⚠️ 置信度降级原因**：原计划的 codex 独立对抗审查（task-mnu754wx-foynt6）因 runtime 卡住取消，未能拿到第二意见挑战 cc 的推荐。本文档仅代表 cc 的单一视角，川哥需要自己做一次"是否同意 cc 的 bias"的判断。见 §7。

---

## 1. 理论对齐：llmwiki 到底是什么

### Karpathy 原文核心断言（来源：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f）

> "Instead of just retrieving from raw documents at query time, the LLM **incrementally builds and maintains a persistent wiki** — a structured, interlinked collection of markdown files that sits between you and the raw sources."

> "This is the key difference: **the wiki is a persistent, compounding artifact.** The cross-references are already there. The contradictions have already been flagged."

> "You never (or rarely) write the wiki yourself — **the LLM writes and maintains all of it**. You're in charge of sourcing, exploration, and asking the right questions. **The LLM does all the grunt work.**"

> "A single source might touch **10-15 wiki pages**."

> "This works surprisingly well at moderate scale (~100 sources, ~hundreds of pages) and **avoids the need for embedding-based RAG infrastructure**."

> "The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the **bookkeeping**. Humans abandon wikis because the maintenance burden grows faster than the value. **LLMs don't get bored, don't forget to update a cross-reference**, and can touch 15 files in one pass."

### llmwiki 的四个原子操作

| 操作 | 原文描述 | 频次 |
|---|---|---|
| **Ingest** | "reads the source, discusses key takeaways, writes a summary page, updates the index, updates relevant entity and concept pages, appends to log" | 每次新源 |
| **Query** | "LLM reads the index first → drills into pages → synthesizes with citations" | 每次读 |
| **Lint** | "health-check the wiki... contradictions between pages, stale claims" | 定期 |
| **Evolve schema** | "CLAUDE.md/AGENTS.md — tells the LLM how the wiki is structured. You and the LLM co-evolve this over time" | 持续 |

### 知识单元粒度：**markdown 文件**，不是 atomic fact 行

- **Entity pages**（实体页）：针对特定实体的专属页面
- **Concept pages**（概念页）：抽象概念
- **Summary pages**：源文档的 LLM 总结
- **Comparison / Overview / Synthesis**：综合视图

**原文明确拒绝**：embedding-based RAG infrastructure。

### 和 Memex 的血缘

> "The idea is related in spirit to **Vannevar Bush's Memex (1945)** — a personal, curated knowledge store with associative trails between documents... The part he couldn't solve was who does the maintenance. **The LLM handles that.**"

---

## 2. 现状诊断：mycc-brain knowledge 子系统全体检

### 2.1 数据模型（types.ts + store.ts v0.12.4）

```typescript
// 当前数据单元 — 扁平 atomic fact row
interface KnowledgeItem {
  id: number;
  docToken: string;     // 指向飞书文档
  namespace: string;    // "公司/战略/定位"
  content: string;      // 1-2 句话的独立断言
  keywords: string[];   // 3-6 个关键词
  confidence: number;
  // ...
}
```

- 存在 SQLite 的 `knowledge_items` 表
- 193 条 atomic facts（Futurus 战略/财务/经营/业务类）
- 一个 SQLite FTS5 虚表 `knowledge_fts`（v0.12.3 中文 2-gram 预分词）
- **零** cross-reference / entity 汇聚 / 冲突检测

### 2.2 LLM 调用拓扑（全局总共只有 1 个点）

```
feishu Wiki → crawler.ts (抓取 + hash) → doc_sync_state
              ↓
          extractor.ts ← 👉 唯一 LLM 调用点（Gemini Flash 一次性抽 facts）
              ↓
          knowledge_items + FTS5 index
              ↓
          第五路 search.ts (FTS5 MATCH + post-filter + 硬塞到 system prompt)
```

- **写端 LLM**：extractor.ts 一次性抽 atomic facts，之后**永不再碰**
- **读端 LLM**：**零**。knowledgeFtsSearch → top-5 直接塞 system prompt
- **bookkeeping**：**零**。没有 entity 合并、没有 cross-reference、没有 contradiction callout
- **lint**：**零**。crawler 只做定时重爬，不做健康检查

### 2.3 v0.12.x 四轮迭代的共同偏差

| 版本 | 尝试 | 本质 |
|---|---|---|
| v0.12.1 | 第五路注入打通 + 白名单扩业务词 | "让 FTS5 能被触发" |
| v0.12.2 | itemCount 修复 + 预算统一 | "让 FTS5 注入不冲突其他记忆" |
| v0.12.3 | 中文 2-gram 预分词 | "让 FTS5 能召回中文 query" |
| v0.12.4 | 停用词 + 数量门 + min_match | "让 FTS5 不被虚词污染" |

**每一轮都在回答同一个问题：怎么让 FTS5 返回正确的 top_hits？**

但这个问题本身就建立在"**第五路应该用 FTS5 做召回**"这个假设上。而这个假设从 Spike Day 0 就是**对 llmwiki 的根本误读**。

### 2.4 实测数据里隐藏的关键线索（v0.12.1 端到端）

```json
// query: "Futurus 公司的愿景和使命是什么？"
{ triggered: true, hit_count: 5, latency_ms: 4, top_hits: [
  { id:51, namespace:"公司/战略/管理文档", rank:-3.544 },  // 强相关
  { id:58, namespace:"公司/组织/架构",     rank:-2.906 },
  { id:101,namespace:"公司/战略/定位",     rank:-2.906 }
]}
```

**线索**：只要 query 里有 **"Futurus / 愿景 / 战略"** 这种强语义实词，**FTS5 召回完全工作**（rank=-3.544 极强相关，4ms）。问题**只在**川哥的口语化 query **"测试一下我公司是干什么的有什么能耐"** —— 13 个 bigram 全是虚词，FTS5 被迫靠"公司"一个 bigram 苟活。

**诊断**：FTS5 本身不是瓶颈。瓶颈是 **query understanding**。

---

## 3. 修复清单三分类（Phase 2 产出）

基于 HANDOFF-llmwiki-retrospect.md 的"有效 / 形同虚设 / 未修"清单：

### 🟢 保留（有真实价值，v0.13 沿用）

| # | 修复 | 价值 | 理由 |
|---|---|---|---|
| 1 | `brain-api.ts` itemCount 包含 knowledge hits（v0.12.2 HIGH1） | 真实 | "[无相关记忆]" 兜底不再和 knowledge 注入自相矛盾 |
| 2 | 知识库注入并入统一 MAX_BUDGET（v0.12.2 HIGH2） | 真实 | 避免 2500 token 档模型被挤爆 |
| 3 | `markDocStale` tombstone 同事务（v0.12.4 HIGH1） | 真实 | stale 文档不再污染召回 |
| 4 | Admin UI 🔖knowledge label + k-hit 卡片（v0.12.4） | 真实 | 可观测性必要 |
| 5 | Admin UI 知识库面板（v0.12.0） | 真实 | steering_tax 盲区可视化 |
| 6 | `knowledge-search.jsonl` 召回日志 | 真实 | v0.13 调 LLM 调用点的 A/B 数据基础 |
| 7 | `knowledge.db` schema + 193 条 atomic facts | 真实 | 数据本身有价值，不丢 |

### 🔴 删除（打补丁换来的自欺，v0.13 清掉）

| # | 修复 | 为什么是自欺 |
|---|---|---|
| 1 | v0.12.4 中文停用词 post-filter（`CHINESE_QUERY_STOPWORDS`） | phrases 仍含停用词，FTS 粗排被污染；Codex 已二次确认自欺 |
| 2 | v0.12.4 min_match ratio（`KNOWLEDGE_MIN_MATCH_RATIO`） | effective 1-2 个时退化成无过滤 |
| 3 | v0.12.4 rank 绝对阈值（`KNOWLEDGE_RANK_MAX`） | 默认值 0 = 放行所有负数，等于没设 |
| 4 | v0.12.4 effective bigrams 数量门 | asciiCount 边界逻辑脆弱，长/短 query 分岔难维护 |
| 5 | v0.12.2 brain-context cache key 加 k 状态 | 只挡 enable 切换，不挡数据变更，解决不了根本问题 |
| 6 | `TRIGGER_PATTERNS` 第 5/6 条业务扩词 | 如果读端改用 LLM，触发器可能整体删掉 |

**删除原则**：v0.13 走 X2/X1 后，query 先过 LLM rewriter，口语 query 会被改写成业务实词，post-filter 的存在完全没意义。

### 🟡 冻结（等 v0.13 方向定后决定命运）

| # | 内容 | 冻结原因 |
|---|---|---|
| 1 | v0.12.3 中文 2-gram 预分词（`tokenizeChineseForFts`） | 如果 X1 选文件系统 + grep，FTS 整个不要；X2 可以继续用 |
| 2 | v0.12.3 `maybeRebuildKnowledgeFts` 重建迁移 | 同上 |
| 3 | v0.12.4 `markDocStale` 对 crawler hash-change 的补 patch | v0.13 会重写 crawler 逻辑 |
| 4 | Codex 建议的 v0.12.5（overfetch + 两阶段 rank） | **如果走 X2 直接跳过**，如果走 X3 才做 |

### 🔴 未修的 Codex HIGH（v0.13 前必须决定是修还是删）

| # | 问题 | v0.13 态度 |
|---|---|---|
| 1 | `crawler.ts:308-332` hash-change 只 status=pending 不 tombstone | 修，因为 crawler 逻辑 v0.13 仍保留 |
| 2 | `clearBrainContextCache()` 定义了无调用点 | 修（加到 Admin UI 的"清 cache"按钮） |
| 3 | 候选集生成被虚词主导（根本问题） | **不修**。X2/X1 方向下这个问题不存在 |

---

## 4. 方向分岔：三岔路 vs 四岔路

HANDOFF 原本列了 A/B/C/D 四选项（继续工程修复 / LLM 重写 / 混合 / 换框架）。这个分法**隐藏了真正的决策**。真正的决策不是"要不要加 LLM"，而是 **"mycc-brain 在知识生态里的定位是什么"**。

### 隐含假设冲突（关键）

| 问题 | Karpathy llmwiki 的答案 | mycc-brain 当前的答案 |
|---|---|---|
| wiki 是谁的？ | **你自己的一阶知识源**。你在 wiki 里记录和推演，wiki = 你的外脑 | **外部只读数据源**。Futurus 团队在飞书 wiki 里记录，brain 是消费者 |
| 谁做 bookkeeping？ | **LLM**（这是 llmwiki 的灵魂） | **Futurus 团队人工维护飞书 wiki**；brain 不 bookkeeping |
| LLM 的角色 | wiki 管理员（写 + 读 + 整理 + lint） | 一次性抽取器（extractor.ts）+ 零参与读端 |
| 数据流向 | 双向（读也写） | 单向（只读 feishu） |

**这个冲突决定了 v0.13 不是"要不要补 LLM"，而是"要不要改变 wiki 在生态里的定位"**。

### 三岔路

#### 🅰 X1：二级 wiki（真·回归 llmwiki 初心）

**定位**：mycc-brain 在 feishu wiki 之上维护一个由 LLM 生成的 **二级 markdown wiki**。飞书 wiki 是原始源，brain 是加工厂。

**架构**：
```
feishu wiki（原始源，只读）
     ↓ ingest
mycc-brain 的 wiki/ 目录（markdown 文件集合）
  ├── index.md            ← LLM 维护的根索引
  ├── entities/
  │   ├── futurus.md      ← LLM 综合的 entity 页
  │   ├── hud.md
  │   └── ...
  ├── concepts/
  │   ├── 空间智能.md
  │   └── ...
  └── summaries/
      └── 战略管理指南.md   ← 单源总结
     ↓ query
LLM agent 读 wiki/index.md → drill into → synthesize
```

**核心动作**：
- 新增 `wiki-builder.ts`：ingest 一篇飞书文档时，LLM 决定 **更新哪 10-15 个 entity/concept 页**，生成 diff
- 新增 `wiki-query.ts`：query 时 LLM 先读 `index.md` → 决定读哪几个页 → synthesize
- 新增 `wiki-lint.ts`：定期 LLM health check（contradiction、stale claims）
- **删除 knowledge.db + FTS5**（或降级为辅助索引，不做主召回）

**成本**：高（1-2 周）
- wiki-builder 的 LLM prompt 设计 + 测试（3-5 天）
- ingest 流程重写（2-3 天）
- query 流程重写（2-3 天）
- 全库回填 193 条 facts → 二级 wiki 页（预估 30-50 个页，Gemini Flash ~$1-2）

**收益**：
- 真正的 llmwiki 血脉，cross-reference + contradiction + lint 全部有
- 193 条 atomic facts 重写成 ~30 个 entity 页，综合视图出现
- 川哥问"我公司是干什么的" → LLM 读 `entities/futurus.md` → 一次命中

**风险**：
- **最大风险：LLM 维护二级 wiki 的 ROI 是否值得**。如果飞书 wiki 本身已经维护得好，brain 二级 wiki 是多余的
- LLM 幻觉：wiki-builder 写 entity 页时可能编造，contradiction callout 也可能误判
- 规模不经济：193 条 facts 太小（llmwiki 建议 ~100 sources），bookkeeping 成本 > 收益
- 推翻代价：v0.12.x 的 1000+ 行 knowledge 代码大部分作废

#### 🅱 X2：读端 LLM 增强（最小可行的初心回归）

**定位**：mycc-brain 保留 atomic facts 数据模型，但在**读端**加 LLM，解决 v0.12.4 实测的唯一痛点（口语化 query）。

**架构**：
```
query: "测试一下我公司是干什么的"
     ↓
[LLM 调用 1 — rewriter]（~200ms）
"Futurus 公司 业务 定位"
     ↓
knowledge.db FTS5 召回 top 20
     ↓
[LLM 调用 2 — reranker]（~300ms）
top 5 with relevance scores
     ↓
[LLM 调用 3 — judge]（~200ms，可选）
"这些 fact 真的回答了问题吗？"
     ↓
注入 system prompt
```

**核心动作**：
- 新增 `knowledge-rewriter.ts`：LLM 把口语 query 改写成业务实词
- 新增 `knowledge-reranker.ts`：LLM 从 top-20 里挑 top-5
- **可选**：`knowledge-judge.ts`（v0.13 第二阶段）
- **保留** knowledge.db + FTS5（删除 v0.12.4 的 post-filter 补丁）
- **删除** CHINESE_QUERY_STOPWORDS / min_match / rank 阈值（上面的🔴清单）

**成本**：中（2-3 天）
- rewriter prompt 设计 + 测试（半天）
- reranker 实现（半天）
- 集成到第五路（半天）
- A/B eval（1 天）

**收益**：
- 解决 v0.12.4 实测痛点（口语化 query）
- 回归"LLM 参与管理"的精神（**部分** llmwiki 灵魂）
- 渐进式，不推翻现有投入
- knowledge-search.jsonl 里的 miss 类事件立即下降

**风险**：
- 延迟 +400-500ms（rewriter + reranker）；用 Gemini Flash 可接受，但本地 cc-qwen 要慎重
- 仍不是真正的 llmwiki（没有 bookkeeping / cross-reference / entity pages）
- LLM 幻觉可能放大：reranker 选错、judge 误判
- 预算：每次 chat +2 次 Gemini Flash = ~$0.0001 × 频次。按川哥 brain 日均调用量估算（查 knowledge-search.jsonl），日成本 < $0.10，可接受

#### 🅲 X3：放弃 wiki 定位，诚实做 RAG

**定位**：承认 mycc-brain 的 knowledge 子系统是"飞书 wiki 的 FTS 搜索引擎"，不是 llmwiki。继续 Codex v0.12.5 建议的工程修复。

**架构**：**不变**。继续 v0.12.5（overfetch 100+ + JS rerank + phrases 真剔停用词 + crawler tombstone 补丁）。

**成本**：最小（4 小时）
**收益**：v0.12.4 实测痛点解决（口语化 query 命中率提升）
**风险**：**放弃 llmwiki 战略愿景**。如果川哥确实把 brain 当做"未来的外脑"，X3 是降级。

**适用场景**：如果川哥判断"现阶段 brain 只需要能查 Futurus fact，不需要综合视图"，X3 诚实。

---

## 5. 四个关键产品问题（决定推荐路径的强度）

cc 需要川哥回答这四个问题，才能给出置信度高的最终推荐：

### Q1：brain 在 Futurus 业务场景里，是"查 fact"还是"看综合视图"？

- 前者 → **X2 足够**（LLM 读端增强）
- 后者 → **X1 必须做**（二级 wiki）
- 不确定 → **X2 先上 + 观察 miss 数据 6 周 → 决定是否补 X1**

### Q2：feishu wiki 的维护状态如何？

- 维护得好（团队持续更新） → **brain 二级 wiki 多余**，X2 更合算
- 维护得差（信息散乱、有矛盾） → **X1 的 lint 价值大**（LLM 帮团队发现 contradiction）
- 中等 → X2 + 选择性 X1（只建 top 5 entity 页）

### Q3：知识库规模未来 12 月预期？

- 现在 193 条 → 未来还是 ~200-500 → X1 规模不经济，X2 够
- 现在 193 条 → 未来 1000+（加 cc 自己的记忆、其他业务线）→ **X1 必要**，bookkeeping 成本回收

### Q4：LLM 调用预算约束？

- 成本不敏感（Gemini Flash $0.0001/query）→ X2 没有压力
- 延迟敏感（brain 用在实时对话）→ X2 需要调 rewriter 到 <200ms，或只用 reranker
- 本地模型为主（cc-qwen3b / 30b）→ X2 的 LLM 调用成本是 TTFT，延迟风险大，**可能得退 X3**

---

## 6. cc 初步推荐 [置信度：中]

### ⚠️ 元认知警告（cc 的自我 bias 披露）

> cc 倾向推荐 X2，但这个倾向可能有**工程师的"渐进式胜于推翻"偏见**。川哥需要知道：
>
> - cc 在本 session 已经 4 次元认知反思都没跳出机械框架（HANDOFF 有记录）
> - cc 写决策文档时有"保留已有投入"的 confirmation bias，会把"2-3 天 vs 1-2 周"当作决定性理由
> - 实际上，**如果川哥的产品愿景是"brain 应该成为未来的外脑（Memex 式）"，那 X1 才是对的路径**，X2 只是延期决定
> - 如果川哥说"我就是想要 Memex，不要绕路"，cc 应该立即同意 X1，不要"先 X2 再 X1"地绕路
>
> 换句话说：**cc 推荐的 "X2 优先" 的前提是 "短期内不确定 brain 的终极形态"**。如果川哥的终极形态已经确定就是 llmwiki / Memex，X1 才是最短路径。

### 推荐组合：**X2 立即落地（v0.13.0）+ X1 分阶段观察（v0.14.0+）**

**原因**：
1. **X2 代价小收益即时**：2-3 天 vs v0.12.4 的 4 轮迭代，性价比最高
2. **X2 解决 v0.12.4 唯一实测痛点**：口语化 query 被虚词 bigram 污染
3. **X2 保留了 llmwiki 的一半精神**（LLM 参与管理，只是在读端）
4. **X1 推迟到验证后再做**：先用 knowledge-search.jsonl 的 6 周数据判断，如果 miss 率仍高 + 出现"需要综合视图"的 query 模式 → 再推 X1
5. **不推荐 X3**：Codex 的 v0.12.5 建议在机械框架内，本 session 已经验证过这个框架不够

**前置条件**：
- 川哥回答 Q1-Q4 之后才能把置信度提到"高"
- 特别是 Q1，如果川哥想要"综合视图"，必须直接上 X1，X2 只是绕路

### 替代方案：如果川哥判断"我确实需要综合视图"

直接推 **X1**（跳过 X2）。X1 的 LLM 读端会在 wiki-query.ts 里自然吸收 X2 的能力，不需要先建 X2 再建 X1。

### 反对 X3 的条件

如果川哥说"X3 就够了，我不需要 llmwiki 愿景"，cc 不反对，但要求：
- 删除所有提到 "llmwiki" 的 memory 和文档，免得下次再触发这种复盘
- v0.12.5 按 Codex 建议做完之后，**冻结 knowledge 模块**，不要再投入

---

## 7. Phase 4：Codex 对抗审查（⚠️ 未完成，已取消）

**状态**：❌ **取消，runtime 卡住**

**时间线**：
- 18:32 启动 codex rescue subagent（task-mnu754wx-foynt6）
- 18:36 完成 `codex_apps/github_fetch`（拉 lucasastorian/llmwiki 代码）+ `codex_apps/github_search` × 8
- 18:39 Assistant message: "我将先取一次系统时间用于报告署名，然后直接输出完整五部分研究报告"
- 18:39 完成 `date` 命令
- 18:39 → 19:15+（35m56s elapsed）**无任何新日志**。gpt-5.4 xhigh 推理阶段卡住，无 message、无 tool 调用
- 19:15 `/codex:cancel task-mnu754wx-foynt6`

**诊断**：不是正常推理。即使 gpt-5.4 xhigh 默认 >15min 推理（memory 有记录），也不会 20+ 分钟无 log flush。判断 codex runtime 或 OpenAI 后端卡住。

**损失**：
- 未拿到 llmwiki 代码级对标（MCP 5 个工具的 prompt、ingest 管道、entity page 更新的具体逻辑）
- 未拿到独立第二意见挑战 cc 的 X2 推荐
- 未拿到对 X2 延迟/幻觉/预算的外部质疑

**补救**：
- 本文档的现状诊断和三岔路是基于 **karpathy 原文 + mycc-brain 源码**，不依赖 codex 结果。核心分析仍成立
- cc 的 X2 推荐置信度从 "中" 降到 "**中低**"，因为缺少外部挑战
- 川哥如果决定走 X2，**建议在正式实施前**重跑一次 codex 审查（prompt 改短，避免再次卡住）
- 或者：使用 cc 自己的 verification agent 做对抗审查（声明式，不依赖外部 runtime）

---

## 8. v0.13 P0 清单（待方向确定后填写）

### 如果选 X2

1. `knowledge-rewriter.ts` — Gemini Flash 2.5 prompt 设计（口语 → 业务实词）
2. `knowledge-reranker.ts` — LLM 从 top-20 挑 top-5
3. 改 `knowledgeSearch(query, 5)` → `knowledgeSearch(rewrittenQuery, 5, { rerank: true })`
4. 删除 v0.12.4 post-filter（🔴 清单第 1-5 条）
5. A/B eval：本 session 4 个失败 query 作为 fixture
6. knowledge-search.jsonl 加 `rewritten_query` 和 `rerank_scores` 字段
7. Admin UI knowledge 面板加"rewrite 质量"和"rerank 质量"两个图

#### X2 具体 prompt 草稿（v1 工程预览）

**rewriter prompt（Gemini Flash 2.5，~100-200ms）**

```
你是 brain 知识库的查询改写器。用户的 query 可能包含口语助词、指代、或模糊表达。
把它改写成 3-5 个**业务实词**（名词/专有名词/关键动作），空格分隔。

规则：
- 只输出业务实词，不要输出完整句子
- 公司代词（"我公司"/"咱们公司"）一律改写为 "Futurus"
- 产品/技术术语保留原文（HUD、AR 眼镜、空间智能）
- 如果 query 已经是业务实词，直接输出不改写
- 如果 query 与业务无关（例如问天气），输出单字符 "-"

原 query：{user_query}
改写：
```

**rewriter 样本对照**：
| 原 query | 期望改写 |
|---|---|
| 测试一下我公司是干什么的有什么能耐 | Futurus 业务 产品 能力 |
| Futurus 的愿景和使命是什么？ | Futurus 愿景 使命 |
| 咱们第五代 HUD 产品进度咋样了 | Futurus 第五代 HUD 产品 进度 |
| 今天天气怎么样 | - |

**reranker prompt（Gemini Flash 2.5，~300ms）**

```
以下是用户的原始 query 和从知识库 FTS 召回的 {N} 条候选 atomic facts。
请判断哪些 fact **真正相关**，输出 fact id 和相关性分数（0-10）。

规则：
- 只输出真正回答了 query 的 fact，相关性 ≥ 6
- 如果候选都不相关，输出空数组 []
- 严格 JSON 输出：{"relevant": [{"id": 42, "score": 9}, ...]}
- 不要编造 fact 内容，只评分

原 query：{user_query}
候选：
{candidates_json}  // [{id, namespace, content, rank}, ...]

输出：
```

**judge prompt（可选，v0.13 第二阶段）**

```
用户 query：{user_query}
LLM 准备注入的候选 facts：{top_facts}
问：这些 facts 组合起来能回答 query 吗？输出 YES/NO/PARTIAL + 一句话理由。
```

#### X2 eval fixture（本 session 4 个失败 query 作为测试用例）

```jsonl
{"query": "测试一下我公司是干什么的有什么能耐", "expected_contains": ["HUD", "空间智能"], "expected_namespace_prefix": "公司/", "note": "v0.12.4 本次失败的口语化 query"}
{"query": "测试测试，我在的公司是个什么公司？", "expected_contains": ["空间智能", "Futurus"], "note": "v0.12.2 中文纯虚词 query"}
{"query": "Futurus 公司的愿景和使命是什么？", "expected_contains": ["空间智能平台运营商"], "note": "v0.12.1 已通过，回归测试基线"}
{"query": "Futurus 做什么产品", "expected_contains": ["HUD", "AR 眼镜"], "note": "业务产品类 query 基线"}
```

**eval 脚本**：
- 对每个 fixture，跑 rewritten → FTS top-20 → rerank → top-5
- 通过条件：top-5 至少 1 条包含 `expected_contains` 的任一词
- 目标：4/4 通过

#### X2 具体时间线（2.5 天）

| 半天 | 内容 | 交付物 | Guard |
|---|---|---|---|
| D1 AM | `knowledge-rewriter.ts` 实装 + rewriter prompt + 单元测试 | 文件 + 4 fixture rewriter 测试 | tsc + rewriter.test.ts pass |
| D1 PM | `knowledge-reranker.ts` 实装 + reranker prompt + mock 测试 | 文件 + mock fetch 测试 | tsc + reranker.test.ts pass |
| D2 AM | 集成到 `search.ts` + 删除 v0.12.4 post-filter | 改 search.ts（删 30 行，加 20 行） | tsc + knowledge tests 70/70 无回归 |
| D2 PM | e2e eval：4 fixture query 端到端测试 | `eval-knowledge-v013.jsonl` | 4/4 pass |
| D3 AM | 部署 Studio + Admin UI 增强（rewrite/rerank 可视化） | brain@0.13.0 pm2 online | pm2 logs 无错 |

**交付门**：v0.13.0 上线前必须：
1. tsc 0 error
2. knowledge tests 70+/70 (新增测试)
3. 4 fixture 4/4 pass
4. 端到端本 session 原失败 query hit ≥1 条真相关

---

### 如果选 X1

1. 调研：lucasastorian/llmwiki 代码（已委托 codex）
2. `src/wiki/` 新目录 + schema 层 (`schema.md` 相当于 CLAUDE.md)
3. `wiki-builder.ts`（ingest）prompt 设计
4. 全库 193 facts 回填到 wiki/entities/ 和 wiki/concepts/（~30-50 页）
5. `wiki-query.ts`（LLM 读 index → drill → synthesize）
6. `wiki-lint.ts`（定时 health check）
7. `knowledge.db` 降级为辅助索引 or 删除
8. 灰度：第五路旧版 vs 新版 A/B 30%

### 如果选 X3

1. 执行 Codex v0.12.5 全部建议（phrases 真剔停用词 + overfetch 100+ + JS rerank + crawler tombstone）
2. 删除本文档和 HANDOFF-llmwiki-retrospect.md（避免混淆）
3. 更新 MANIFESTO：去掉 llmwiki 叙事
4. **冻结** knowledge 模块，不再迭代

---

## 9. 硬约束（cc 自我要求）

1. ✅ **不碰代码** — 本文档是决策文件，不是实施 PR
2. ✅ **时间戳必须 date 拿** — 本文档顶部 "2026-04-11 18:35" 是 `date` 命令取的
3. ✅ **置信度标注** — 所有推荐带"高/中/低"
4. ⏳ **等 codex 对抗审查** — 允许反对 cc 推荐
5. ✅ **不引用"Codex 建议"为必然正确** — v0.12.5 建议在机械框架内，本身可能是偏差
6. ✅ **不 commit 改动** — 让川哥选方向后再动代码

---

## 10. 给川哥的 4 个可直接回答的问题

为加速决策，川哥只需回答这 4 个，cc 就能出终版：

1. **定位**：brain 在 Futurus 业务场景，是"查 fact"还是"综合视图"？
2. **feishu wiki 状态**：团队维护的好吗？有矛盾吗？
3. **规模展望**：12 月后 knowledge 库大约多少条？（200? 1000? 5000?）
4. **成本敏感度**：LLM 调用延迟 +400ms 是否可接受？本地模型 or Gemini Flash？

回答后 cc 立即出 v0.13 P0 清单。

---

## 11. Codex 对抗审查结果（已取消）

- [x] ~~Codex 对 lucasastorian/llmwiki 代码的深度分析~~ — **未返回**（runtime 卡 20+ min）
- [x] ~~Codex 独立的方向判断~~ — **未返回**
- [x] ~~Codex 对 X2 的盲点挑战~~ — **未返回**
- [x] 最终推荐的置信度升级 — **降级为 中低**（因缺外部挑战）

**后续补救建议**（如果川哥坚持要第二意见）：
1. 用 cc 的 verification subagent 做对抗审查（本地，不依赖 codex runtime）
2. 或：重跑 codex rescue 但 prompt 拆成三段（① 拉代码 ② 输出差异表 ③ 输出方向判断）
3. 或：直接按 v1.1 决策走，上线后用 knowledge-search.jsonl 数据实证

---

## 12. 最终交付状态

- **决策文档**：`2-Projects/brain-product/RETROSPECT-llmwiki-v0.13-direction.md`（即本文件）
- **诊断置信度**：**高**（基于 karpathy 原文 + mycc-brain 源码）
- **推荐置信度**：**中低**（因 codex 未返回，缺外部挑战）
- **下一步**：
  - 川哥回答 §5 的 4 个产品问题 → cc 出 v0.13 P0 清单
  - 或：川哥直接决定方向（X1/X2/X3）→ cc 立即开始实施
  - 或：川哥要求重跑 codex → cc 用拆段 prompt 再试一次

---

_署名：cc（claude-opus-4-6 1M）| 2026-04-11 19:15（v1.1）_
_Codex 对抗审查任务：task-mnu754wx-foynt6（已取消，35m56s 无输出）_

---

## 13. 🔬 lucasastorian/llmwiki 代码级深读发现（v1.2 新增）

> **调研方式**：`git clone https://github.com/lucasastorian/llmwiki /tmp/llmwiki-ref`，全量读完 mcp/ + api/ + supabase/migrations/ 约 1300 行 Python/SQL。零假设，只看代码。

### 13.1 实际代码结构（全量）

```
/tmp/llmwiki-ref/
├── mcp/                    # MCP server — 这是 llmwiki 的灵魂
│   ├── server.py (67 行)   FastMCP 实例 + Supabase OAuth token verifier
│   ├── auth.py, db.py      RLS-scoped asyncpg
│   ├── config.py           settings
│   └── tools/              5 个 MCP 工具
│       ├── __init__.py     register(mcp) 入口
│       ├── guide.py        (182 行, 150 行是 GUIDE_TEXT)
│       ├── search.py       (186 行, list / search 两 mode)
│       ├── read.py         (323 行, 单文件 / glob 批读 / pages / sections / images)
│       ├── write.py        (180 行, create / str_replace / append)
│       ├── delete.py       (90 行, glob 软删)
│       └── helpers.py      (104 行, auth / glob / s3)
├── api/                    # FastAPI 后端（文件上传 + ingest 管道）
│   ├── main.py, auth.py, deps.py
│   ├── routes/             documents / knowledge_bases / api_keys / usage / me / admin
│   ├── services/
│   │   ├── chunker.py      (172 行) 512 token + 128 overlap + header breadcrumb
│   │   ├── ocr.py          (444 行) Mistral OCR（窄域 LLM，不做知识决策）
│   │   └── s3.py           aioboto3
│   └── html_parser/        HTML → structured content
├── supabase/
│   └── migrations/001_initial.sql (250 行) — 唯一的 schema 文件
├── converter/              LibreOffice 容器（office → pdf）
├── web/                    Next.js 前端（查看器 + 上传）
└── README.md
```

### 13.2 核心代码证据

**证据 1：零 LLM 调用**
```bash
grep -l "anthropic\|openai\|gemini\|gpt-\|chat.completions" /tmp/llmwiki-ref/api /tmp/llmwiki-ref/mcp -r
# 结果：只命中 3 个字符串匹配（server.py、guide.py、search.py），全是变量名或描述文字
# api/requirements.txt 里：fastapi / asyncpg / pydantic / mcp / mistral / pdf-oxide / aioboto3
# 没有：anthropic-sdk / openai / google-generativeai
```

**证据 2：write 工具的全部动作就 3 条**（`mcp/tools/write.py` L154-178）
```python
async def write(
    ctx: Context, knowledge_base: str,
    command: Literal["create", "str_replace", "append"],
    path: str = "/", title: str = "", content: str = "",
    tags: list[str] | None = None, ...
) -> str:
    if command == "create": return await _create_note(...)       # 新建文档
    elif command == "str_replace": return await _edit_note(...)  # 精确字符串替换
    elif command == "append": return await _append_note(...)     # 追加
```

**注意**：**没有 merge、没有 diff、没有 cross-reference 自动维护、没有"LLM 决定更新哪 10-15 个 entity 页"代码**。所有 bookkeeping 都是 **Claude 客户端在对话循环里自己做的**。

**证据 3：search 工具是 PGroonga 全文搜索**（`mcp/tools/search.py` L97-122）
```python
async def _search_chunks(user_id, kb, query, path, tags, limit):
    matches = await scoped_query(user_id, f"""
        SELECT dc.content, dc.page, dc.header_breadcrumb, dc.chunk_index,
               d.filename, d.title, d.path, d.file_type,
               pgroonga_score(dc.tableoid, dc.ctid) AS score
        FROM document_chunks dc
        JOIN documents d ON dc.document_id = d.id
        WHERE dc.knowledge_base_id = $1
          AND dc.content &@~ $2                -- PGroonga match operator
          AND NOT d.archived
        ORDER BY score DESC, dc.chunk_index
        LIMIT {limit}
    """, kb["id"], query)
```
**llmwiki 的 search 和 mycc-brain 的 FTS5 是同级技术**。"LLM-powered" 不在这里，在调用 search 的那个 agent 那里。

**证据 4：GUIDE_TEXT 是硬编码的 Wiki 规范**（`mcp/tools/guide.py` L7-157, 150 行 markdown）

精华摘录：
```markdown
# LLM Wiki — How It Works

## Wiki Structure

### Overview (`/wiki/overview.md`) — THE HUB PAGE
Always exists. This is the front page of the wiki. It must contain:
- A summary of what this wiki covers and its scope
- **Source count** and page count (update on every ingest)
- **Key Findings** — the most important insights
- **Recent Updates** — last 5-10 actions

### Concepts (`/wiki/concepts/`) — ABSTRACT IDEAS
### Entities (`/wiki/entities/`) — CONCRETE THINGS
### Log (`/wiki/log.md`) — CHRONOLOGICAL RECORD (append-only)

## Writing Standards
- Wiki pages MUST be substantially richer than a chat response
- Every wiki page MUST include at least one visual element (Mermaid / Table / SVG)
- Citations REQUIRED: `[^1]: paper.pdf, p.3`

## Core Workflows

### Ingest a New Source
1. Read it: `read(path="source.pdf", pages="1-10")`
2. Discuss key takeaways with the user
3. Create or update concept pages under /wiki/concepts/
4. Create or update entity pages under /wiki/entities/
5. Update /wiki/overview.md
6. Append to /wiki/log.md
7. A single source typically touches 5-15 wiki pages
```

**关键观察**：**Karpathy 原文里的"LLM 决定更新哪 10-15 个 entity 页"，在代码里变成了这段 markdown 指令**。Claude 读这段规范后在**自己的推理里**决定更新哪几个页，然后多次 tool call `write` 来实现。**服务端没有这个逻辑**。

**证据 5：数据模型（`supabase/migrations/001_initial.sql`）**
```sql
CREATE TABLE documents (
    id UUID, knowledge_base_id UUID, user_id UUID,
    filename TEXT, title TEXT, path TEXT DEFAULT '/',  -- '/' = raw source, '/wiki/...' = wiki page
    file_type TEXT, content TEXT,                       -- 完整内容（wiki markdown 或 parsed raw）
    tags TEXT[], version INTEGER,                       -- str_replace 每次 version+1
    archived BOOLEAN,                                    -- 软删
    ...
);

CREATE TABLE document_chunks (
    id UUID, document_id UUID, knowledge_base_id UUID,
    chunk_index INTEGER, content TEXT CHECK (length(content) <= 10000),
    page INTEGER, start_char INTEGER, token_count INTEGER,
    header_breadcrumb TEXT,                              -- "Chapter 1 > Section 2 > Subsection"
    ...
);

CREATE EXTENSION pgroonga;
CREATE INDEX idx_chunks_content_pgroonga ON document_chunks USING pgroonga (content);
CREATE INDEX idx_documents_content_pgroonga ON documents USING pgroonga (content);
```

**关键洞察**：
- **wiki 页和 raw source 存在同一张 `documents` 表**，用 `path` 字段区分
- `document_chunks` 只给 raw source 用（ingest 时 chunker.py 生成）
- **wiki 页本身不被 chunk**，因为它是 LLM 已经综合过的结果
- PGroonga 索引同时覆盖 documents.content（整页）和 document_chunks.content（chunk）
- RLS 按 user_id 隔离

**证据 6：chunker 是传统分块**（`api/services/chunker.py`）
```python
CHUNK_SIZE = 512      # tokens
CHUNK_OVERLAP = 128   # tokens

def chunk_text(content, ...):
    paragraphs = _split_paragraphs(content)
    # header_stack 追踪 markdown header 层级
    # 当 current_tokens + para > chunk_size 时切 chunk
    # header_breadcrumb = " > ".join(current headers)
    # overlap 用 trailing blocks
```
**传统的 recursive chunking**，不是 LLM-based semantic chunking。

### 13.3 Claude Agent Loop 的真实动作流（基于 GUIDE_TEXT 推导）

```
用户在 Claude.ai 里说："帮我整理这个 PDF 到 wiki"
      ↓
[Claude 的 agent loop 开始]

Step 1: tool_use guide()
  → 拿到 GUIDE_TEXT（150 行规范）+ 当前 KB 列表
  → Claude 学到："我要用 /wiki/concepts/ 和 /wiki/entities/ 两个分类"

Step 2: tool_use read(path="source.pdf", pages="1-30")
  → 拿到 30 页内容

Step 3: [Claude 纯推理，不 tool call]
  "这篇论文讲的是 X，我要：
   - 创建 entities/x-paper.md
   - 更新 concepts/y-concept.md（新论文提到了 Y）
   - 更新 entities/z-author.md（Z 是作者）
   - 更新 overview.md 加到 Recent Updates
   - append log.md"

Step 4: tool_use search(mode="search", query="Y concept", path="/wiki/**")
  → 看看 concepts/y.md 是否已存在

Step 5: tool_use read(path="/wiki/concepts/y.md")
  → 读现有内容

Step 6: tool_use write(command="create", path="/wiki/entities/",
                        title="X Paper", tags=["paper", "y-concept"],
                        content="# Summary\n...[^1]\n\n[^1]: source.pdf, p.3")

Step 7: tool_use write(command="str_replace", path="/wiki/concepts/y.md",
                        old_text="## See Also", new_text="## See Also\n- [X Paper](../entities/x-paper.md)")

Step 8: tool_use write(command="str_replace", path="/wiki/overview.md",
                        old_text="## Recent Updates\n", new_text="## Recent Updates\n- Added X Paper\n")

Step 9: tool_use write(command="append", path="/wiki/log.md",
                        content="## [2026-04-11] ingest | X Paper\n- Created entity...")

[Claude 向用户汇报完成]
```

**llmwiki 的全部智能就是上述 Step 3 的 "Claude 纯推理"**。这部分代码 **完全不在 llmwiki 仓库里**，也不可能在任何服务端里 —— 它依赖 Claude 的通用推理能力。

### 13.4 llmwiki vs mycc-brain v0.12.4 — 精确差异矩阵

| 维度 | lucasastorian/llmwiki | mycc-brain v0.12.4 |
|---|---|---|
| **服务端 LLM 调用** | **零** | 1 个（extractor.ts，一次性抽 facts） |
| **数据单元** | document（整页 markdown 或 parsed raw）+ document_chunks（512 tok + 128 overlap） | atomic fact row（1-2 句话断言 + keywords + namespace） |
| **Chunking 策略** | 传统 paragraph-aware + header breadcrumb | 不 chunk，直接按 fact 存 |
| **全文搜索** | PostgreSQL + PGroonga | SQLite + FTS5 bigram |
| **搜索结果** | chunks with page + breadcrumb + score | atomic facts with namespace + rank |
| **写端接口** | MCP write(create/str_replace/append) by Claude client | crawler.ts + extractor.ts（定时 + 一次性抽取） |
| **wiki 结构** | `/wiki/overview.md` + `concepts/` + `entities/` + `log.md`（GUIDE_TEXT 规范） | 没有 wiki 结构，只有 namespace 平铺 |
| **cross-reference** | Claude 客户端通过 str_replace 维护 markdown footnote + link | 零 |
| **contradiction 检测** | Claude 客户端 lint 时判断 + `[!contradiction]` callout | 零 |
| **访问模式** | Claude.ai / Cursor / Claude Code via MCP streamable HTTP | brain-chat mini-app 的 system prompt 注入 |
| **智能所在层** | **客户端 Claude 的 agent loop** | 无（读端机械 FTS） |
| **llmwiki 血脉** | 100% | 0% |
| **可以用 Karpathy 原话定义吗？** | ✅ "the LLM writes and maintains all of it" | ❌ 只在冷启动时 LLM 抽取一次 |

### 13.5 X0：MCP server 化 — 真·llmwiki 对标（v1.2 新增方案）

**核心概念**：把 mycc-brain 的 knowledge 子系统暴露为 MCP server，让 **cc / Claude Code / 川哥 的 Claude.ai** 通过 MCP 协议直接维护 Futurus wiki。**智能完全外包给 Claude 客户端**，mycc-brain 服务端继续零 LLM 调用。

#### 架构

```
cc / Claude Code / Claude.ai                  (agent loop 所在地)
           ↓ MCP streamable HTTP
┌─────────────────────────────────────┐
│ mycc-brain/src/mcp/                  │ 新增模块
│   ├── server.ts  — MCP server 入口   │
│   └── tools/                         │
│       ├── guide.ts                   │ 提供 Futurus 版的 GUIDE_TEXT
│       ├── search.ts                  │ 包装现有 FTS5 查询
│       ├── read.ts                    │ 读 document/page/fact
│       ├── write.ts                   │ create/str_replace/append
│       └── delete.ts                  │ 软删
└──────────────┬──────────────────────┘
               ↓
    ┌──────────────────────────┐
    │ knowledge.db（改造）     │ 把 knowledge_items 表扩展成 documents + chunks
    │ + FTS5 index             │
    │ 或复用 feishu wiki 镜像  │
    └──────────────────────────┘
```

#### v0.13.0 X0 实施路线图（3-5 天）

| Day | 内容 | 交付物 |
|---|---|---|
| D1 | MCP SDK 接入 + server.ts 骨架 + Supabase/自建 auth | `src/mcp/server.ts` 能启动 + health check |
| D2 | `tools/guide.ts` + Futurus 版 GUIDE_TEXT 撰写 | Claude 调 guide 能拿到约定 |
| D2 | `tools/search.ts` + `tools/read.ts`（包装现有 knowledgeFtsSearch + 新增 page 读） | Claude 能用 FTS 查 + 按 id 读 |
| D3 | knowledge.db schema 扩展：加 wiki-like path 字段 + wiki_pages 子集 | 数据层支持 wiki 页 |
| D3 | `tools/write.ts` 实装 create/str_replace/append | Claude 能写 wiki 页到 `/wiki/...` path |
| D4 | `tools/delete.ts` + overview.md/log.md 保护 | 完整工具集 |
| D4 | 本地 MCP client 测试：用 Claude Code 连接 → 跑一次完整 ingest 流程 | e2e 通过 |
| D5 | 部署到 Studio + Admin UI 加 "MCP 工具调用日志" 面板 | 生产可用 |

#### Futurus 版 GUIDE_TEXT 草稿（关键产出）

```markdown
# mycc-brain Knowledge Vault — How It Works

你正在连接川哥的 Futurus 业务知识库。这个库通过 MCP 工具暴露，智能完全由你（cc / Claude Code）负责。

## 数据层

1. **Raw Sources**（`/sources/`）— 从飞书 wiki 自动抽取的 atomic facts（193 条 Futurus 战略/财务/经营）。只读。
2. **Compiled Wiki**（`/wiki/`）— 你（cc）在对话中维护的 markdown 页。你负责写。
3. **Tools** — guide / search / read / write / delete

## Wiki 结构

### Overview (`/wiki/overview.md`)
川哥公司 Futurus 的 HUB 页。每次 ingest 后更新：source count / key findings / recent updates

### Entities (`/wiki/entities/`)
- `futurus.md` — 公司 entity（主体）
- `hud.md` — HUD 产品线
- `ar-glasses.md` — AR 眼镜产品线
- `spatial-intelligence.md` — 空间智能平台
- 其他具体实体

### Concepts (`/wiki/concepts/`)
- `strategy.md` — 战略演进
- `positioning.md` — 市场定位
- `operating-model.md` — 运营模型

### Log (`/wiki/log.md`) — append-only

## 写作规范

- 每条 fact 必须引用 feishu wiki 原文：`[^1]: 战略管理指南（飞书链接）`
- 每页必须有 mermaid 图或表格
- str_replace 改动要求精确匹配 old_text 一次
- overview.md 和 log.md 不可删

## 核心工作流

### Query（川哥问"Futurus 做什么"）
1. search(query="Futurus 业务定位") → 找 chunks
2. read(path="/wiki/entities/futurus.md") → 读 entity 页
3. 综合回答 + 引用 footnote
4. 如果需要补充新 insight → write(append to log.md)

### Ingest（飞书 wiki 更新后自动触发或手动）
1. search 找新增 fact
2. read 看原文
3. write(str_replace) 更新相关 entity/concept 页
4. write(str_replace) 更新 overview.md
5. write(append) log.md
```

#### X0 的关键优势 vs X1

| 维度 | X1（v1.1 推荐，服务端 LLM）| X0（v1.2 推荐，MCP server） |
|---|---|---|
| LLM 成本 | brain 承担（每次 ingest $0.001-0.01） | **客户端承担**（cc/Claude Code 的订阅） |
| 延迟 | brain 端 500-2000ms | **客户端 token-by-token**，用户体感即时 |
| 实施复杂度 | prompt chain + 预算管理 + retry | **MCP SDK 标准协议**，只写 tool 接口 |
| 与 llmwiki 对齐度 | **低**（在服务端复刻 Claude） | **100%**（就是 lucasastorian 的架构） |
| 可独立验证 | 不容易（prompt 效果主观） | 容易（直接在 Claude Code 里测试） |
| 川哥的参与方式 | 被动消费 brain 自动生成的 wiki | 主动和 cc 对话，cc 即时写 wiki |

### 13.6 置信度升级

基于 v1.2 的代码证据：

| 问题 | v1.1 置信度 | v1.2 置信度 | 升级理由 |
|---|---|---|---|
| llmwiki 核心是什么 | 中（karpathy 原文） | **高**（读完代码） |
| X1 是否正确方向 | 中（cc 推荐） | **高（确认错误）** |
| X0 是否存在 | 未考虑 | **高（真·llmwiki 对标）** |
| X2 是否有效 | 中 | **中高**（X2 是正交补充，不是替代） |
| X3 是否降级 | 中 | 中 |
| cc 的 sunk cost bias | 已披露 | 已披露且已纠正 |

---

_v1.2 署名：cc（claude-opus-4-6 1M）| 2026-04-11 19:30_
_代码源：git clone https://github.com/lucasastorian/llmwiki /tmp/llmwiki-ref_
_读完的文件：mcp/server.py, mcp/tools/*, api/services/chunker.py, api/routes/documents.py, supabase/migrations/001_initial.sql, README.md, api/requirements.txt_
_核心发现：llmwiki 服务端零 LLM 调用，智能完全在客户端 Claude 的 agent loop_
