# HANDOFF — memory-v5 跨 session 交接文档

> **新 session 接手本项目时，先读这个文件。**
> 最后更新：2026-03-29（P2 完成，版本 v5.5）

---

## 你需要知道的背景

mycc 的记忆系统当前是 **v4（TurboQuant）**，核心能力：
- 三层存储：RECENT_EVENTS（24h 流水）→ memory-items（274 条原子事实）→ MEMORY.md（索引）
- 混合检索：关键词正则 + TF-IDF 余弦 + Qwen3-Embedding 向量语义
- 残差版本链：#base + →Δ: + →supersedes:
- 分层失真预算：Resource→Item 保留 ≥95%，Item→Category 保留 ≥80%
- 主动遗忘：每日 04:00 清理

v4 的完整架构讲解见：**`3-Thinking/05-记忆认知自进化架构.md`**

本项目目标是升级到 **v5**，吸收三个开源项目的精华。

---

## 三个参考项目（已研究完毕，不需要再读仓库）

| 项目 | 仓库 | 我们吸收了什么 |
|------|------|--------------|
| **QMD** | github.com/tobi/qmd | RRF 融合评分、查询扩展、LLM 重排、分数解释 |
| **OpenViking** | github.com/volcengine/OpenViking | L0/L1/L2 渐进加载、scope 隔离、透明检索轨迹 |
| **lossless-claw** | github.com/martian-engineering/lossless-claw | DAG 层次摘要、expand 回溯、会话过滤 glob |

详细研究记录见：**`research.md`**

---

## 升级计划（7 项改进，3 个优先级）

### P0：高收益 + 低改动

| # | 改进 | 来源 | 改哪个文件 | 状态 |
|---|------|------|-----------|------|
| 1 | **RRF 融合评分** — 三路检索结果用 Reciprocal Rank Fusion 统一排序，替代简单合并 | QMD | `context-loader.ts` hybridMatchCategories() | ✅ 完成 |
| 2 | **检索轨迹** — 每次注入记录命中了哪些类别/条目/分数，写入 trajectories/ | QMD + OpenViking | `context-loader.ts` loadSharedContext() 返回值 | ✅ 完成 |
| 3 | **会话过滤** — glob 模式排除低价值对话（定时任务、广播）不存入 chat-memory | lossless-claw | `chat-memory.ts` 入口过滤 | ✅ 完成 |

### P1：中等收益 + 中等改动

| # | 改进 | 来源 | 改哪个文件 | 状态 |
|---|------|------|-----------|------|
| 4 | **L0 渐进加载** — 所有 project/agent 类别生成一行 L0 概览，始终注入 | OpenViking | `context-loader.ts` generateL0Overview() | ✅ 完成 |
| 5 | **agent scope 扩展** — 新增 [agent/技能] [agent/踩坑]，始终注入 | OpenViking | `memory-items.md` + `context-loader.ts` ALWAYS_INJECT | ✅ 完成 |

### P2：高收益 + 高改动

| # | 改进 | 来源 | 改哪个文件 | 状态 |
|---|------|------|-----------|------|
| 6 | **DAG 对话摘要** — 对话历史用层次化 DAG 压缩，支持 expand 回溯到原文 | lossless-claw | `chat-memory.ts` 重写摘要逻辑 | ✅ 完成 |
| 7 | **LLM 重排** — MMR 后用本地 reranker 模型对 Top 20 候选二次打分 | QMD | `context-loader.ts` MMR 之后新增阶段 | ✅ 完成 |

### B01：SQLite 统一存储（P2 完成后追加实施）

| # | 改进 | 改哪个文件 | 状态 |
|---|------|-----------|------|
| 8 | **SQLite 统一存储** — better-sqlite3 + sqlite-vec，md 为主源自动同步 | 新建 `memory-db.ts` + 改 `context-loader.ts` + `chat-memory.ts` | ✅ 完成 |

### 跟踪候选（当前不做，后续跟进）

详见 **`backlog.md`**。这些不是"不做"，是"当前优先级不到"。

| 特性 | 何时重新评估 |
|------|-------------|
| ~~**SQLite 全消息持久化**（B01，最高优先）~~ | ✅ 已完成 |
| AST 感知分块（B02） | 接入代码仓库检索时 |
| viking:// URI（B03） | 多 Agent 共享上下文场景 |
| AGFS 分布式后端（B04） | 多设备同步需求增长时 |
| 加密存储（B05） | 对外开放 mycc 服务时 |
| 多租户隔离（B06） | 多用户/多 Agent 场景 |

### 三项目持续关注

QMD / OpenViking / lossless-claw 保持跟踪，有新特性随时分析吸收。详见 `backlog.md` 跟踪机制。

---

## 实施约束

1. **降级优先**：每个新功能不可用时必须回退到 v4 逻辑，不阻塞主流程
2. **增量可验证**：每项改动独立可测，不依赖其他改动
3. **fire-and-forget**：新增的检索轨迹、查询扩展等不能增加用户可感知延迟
4. **依赖本地化**：不引入新的外部服务依赖（Ollama 已有除外）

---

## 接手后的第一步

根据你当前 session 的目标，选择：

**实施 B01 SQLite 迁移**（当前最高优先级）：
1. 读 `backlog.md` 的 B01 详细规划——三阶段方案 + 完整表结构 + RaBitQ 参数
2. 阶段一先做：SQLite 统一存储 + FTS5 + md→SQLite 同步
3. 关键约束：memory-items.md 是主源，SQLite 是加速层，单向同步
4. 理论参考：`~/Downloads/RaBitQ-TurboQuant-综合分析与优化方案.md`

**只是了解进度**：
1. P0/P1/P2 全部已完成（v5.5）
2. 看 `decisions.md` 了解已做的技术决策
3. 看 `backlog.md` 了解下一步方向

---

## 关键决策记录

> 重大决策同步记录到 `decisions.md`，这里只放最影响方向的几条。

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-03-29 | 不部署三项目，只吸收设计 | mycc 单机 M5 芯片，三项目依赖重（Docker/OpenClaw/Python 3.10+），ROI 不如直接改代码 |
| 2026-03-29 | scope 扩展到 4 个而非 6 个 | OpenViking 的 queue/temp 是内部处理用，mycc 不需要 |
| 2026-03-29 | RRF k=60（QMD 默认值） | 学术标准值，后续可调 |
| 2026-03-29 | 项目放 2-Projects/memory-v5 | 正在推进的项目，完成后代码在 .claude/skills/，本目录归档到 5-Archive/ |
| 2026-03-29 | DAG 摘要不调 LLM | 保持轻量原则一致，纯本地规则提取（用户问题 + 结论拼接），DAG 提供结构化回溯能力 |
| 2026-03-29 | Reranker prompt 格式：批量评分 | 逐条调用 reranker 太慢（10 次 RT），改为一次性传入所有候选让模型批量打分 |
| 2026-03-29 | Reranker 权重 0.6:0.4 | QMD 默认值，rerank 占 60%、原始分占 40%，后续可调 |
| 2026-03-29 | 向量压缩三阶段渐进 | float32→int8(4x)→RaBitQ(28x)，按数据量触发，不提前优化 |
| 2026-03-29 | TurboQuant 管语义、RaBitQ 管向量 | 两个理论不同层面分工：残差版本链管内容版本控制，RaBitQ 管向量存储压缩 |
| 2026-03-29 | RaBitQ 随机矩阵存种子不存全矩阵 | 512×512 float32 = 1MB > 数据本身，存 8B 种子运行时重建 |

---

## 文件导航

```
2-Projects/memory-v5/
├── README.md        ← 项目总览、当前状态（对外）
├── HANDOFF.md       ← 本文件，跨 session 交接（新 session 必读）
├── research.md      ← 三项目研究对比详情
├── plan.md          ← v5 升级方案详细设计（P0/P1/P2，已完成）
├── backlog.md       ← ⭐ B01 SQLite 三阶段方案 + RaBitQ 参数（下一步重点）
└── decisions.md     ← 技术决策记录

理论参考（不在本目录）：
├── ~/Downloads/RaBitQ-TurboQuant-综合分析与优化方案.md  ← RaBitQ×TurboQuant 完整分析
├── 3-Thinking/05-记忆认知自进化架构.md                  ← v4→v5 完整架构讲解

核心代码（不在本目录）：
├── .claude/skills/mycc/scripts/src/services/context-loader.ts  ← 检索核心（RRF+L0+轨迹+重排）
├── .claude/skills/mycc/scripts/src/services/chat-memory.ts     ← 对话记忆（DAG+过滤）
├── .claude/skills/mycc/scripts/src/services/embedding.ts       ← 向量化
└── 0-System/memory-items.md  ← 记忆数据主源
```
