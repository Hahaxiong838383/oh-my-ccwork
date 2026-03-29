# 跟踪候选（Backlog）

> 当前优先级不高但后续会用到的特性。P0/P1/P2 完成后回来评估。
> 同时跟踪三个参考项目的更新，有新特性随时分析。

---

## 候选特性

| ID | 特性 | 来源 | 当前不做原因 | 何时重新评估 | 状态 |
|----|------|------|-------------|-------------|------|
| B01 | **SQLite 统一存储** | lossless-claw | — | — | ✅ 阶段一完成（scope + centroids + FTS5） |
| B02 | **AST 感知分块** | QMD | 当前记忆是自然语言 Item | 接入代码仓库检索时（如 mycc-web 代码） | ⬜ 候选 |
| B03 | **viking:// URI 统一寻址** | OpenViking | 改造成本 > 收益 | 多 Agent 协作场景（cc+codex+gemini 共享上下文）| ⬜ 候选 |
| B04 | **AGFS 分布式后端** | OpenViking | 单机运行够用 | 多设备同步需求增长时（NAS↔MacBook↔远程 Mac） | ⬜ 候选 |
| B05 | **加密存储** | OpenViking | 单用户无安全风险 | 对外开放 mycc 服务时 | ⬜ 候选 |
| B06 | **多租户隔离** | OpenViking | 单用户 | 多用户/多 Agent 场景 | ⬜ 候选 |

### B01 详细规划（SQLite + 向量压缩，优先级最高）

> 2026-03-29 更新：整合 RaBitQ (arXiv:2405.12497) 和 TurboQuant (arXiv:2504.19874) 分析结论。
> 完整分析文档：`~/Downloads/RaBitQ-TurboQuant-综合分析与优化方案.md`

**为什么后续会需要**：
1. DAG 摘要（P2-6）的节点关系用 JSON 文件存不够灵活，SQLite 天然支持关系查询
2. 检索轨迹（P0-2）的 JSONL 随时间增长需要索引，SQLite FTS5 比逐行扫描快很多
3. memory-items 当前 274 条，增长到 1000+ 时 JSON/Markdown 解析性能会成瓶颈
4. lossless-claw 的 SQLite 方案已验证可行（168 个测试用例）

**核心设计原则**：
- `memory-items.md` 保持为**人类可读的主源**，SQLite 是检索加速层
- 同步方向：md → SQLite（单向）
- 向量压缩按数据量渐进升级，不提前过度优化

#### 三阶段渐进方案

| 阶段 | 触发条件 | 内容 | 向量存储 | 压缩比 | 状态 |
|------|---------|------|---------|--------|------|
| 一 | **现在** | SQLite + FTS5 + centroids + scope | float32 原样存 | 1x | ✅ 完成 |
| 二 | items > 500 | + int8 标量量化 | int8[512] + float32 re-rank | 4x | ⬜ 待办 |
| 三 | items > 5000 | + RaBitQ 1-bit | 512-bit code + popcount | 28x | ⬜ 待办 |

#### 阶段一 SQLite 表结构

```sql
-- 主表
CREATE TABLE memory_items (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  scope TEXT NOT NULL,              -- user/project/agent/session
  content TEXT NOT NULL,
  stars INTEGER DEFAULT 0,
  vector BLOB,                      -- float32[512], 2048 B
  norm REAL,
  base_tag TEXT,                    -- #base 残差版本链
  delta_ref TEXT,                   -- →Δ:关键词
  supersedes_ref TEXT,              -- →supersedes:关键词
  created_at TEXT NOT NULL,
  event_date TEXT,
  tags TEXT                         -- JSON array
);

CREATE INDEX idx_category ON memory_items(category);
CREATE INDEX idx_scope ON memory_items(scope);

-- FTS5 全文搜索（替代手写 TF-IDF）
CREATE VIRTUAL TABLE memory_fts USING fts5(category, content, tokenize='unicode61');

-- DAG 对话摘要
CREATE TABLE dag_nodes (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  source_start INTEGER,
  source_end INTEGER,
  summary TEXT NOT NULL,
  children TEXT,
  token_count INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 检索轨迹
CREATE TABLE retrieval_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT,
  trace_json TEXT,
  budget_used INTEGER,
  budget_limit INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- L0 类别中心向量
CREATE TABLE centroids (
  category TEXT PRIMARY KEY,
  centroid_vector BLOB,             -- float32[512]
  item_count INTEGER,
  l0_summary TEXT,
  updated_at TEXT
);
```

#### 阶段二 int8 量化（在阶段一基础上加列）

```sql
ALTER TABLE memory_items ADD COLUMN vector_int8 BLOB;   -- int8[512], 512 B
ALTER TABLE memory_items ADD COLUMN quant_min REAL;
ALTER TABLE memory_items ADD COLUMN quant_scale REAL;
```

检索：int8 粗筛 Top 50 → float32 精排 Top 10。

#### 阶段三 RaBitQ 1-bit（在阶段二基础上加列）

```sql
ALTER TABLE memory_items ADD COLUMN rabitq_code BLOB;   -- 64 B (512 bits)
ALTER TABLE memory_items ADD COLUMN rabitq_inner REAL;   -- <o_bar, o>

CREATE TABLE vector_config (
  key TEXT PRIMARY KEY,
  value BLOB
);
-- 存 rotation_seed (8 B), 运行时重建 512×512 正交矩阵
```

检索：centroid 粗筛类别（20 次 float32）→ RaBitQ popcount 中筛（~100 次）→ float32 精排 Top 10。

**RaBitQ 关键参数**：
- 码长：D = 512 bits（每维 1 bit）
- 查询量化：B_q = 4 bits
- 距离计算：B_q 次 bitwise-AND + popcount
- 误差界：O(1/√512) ≈ 4.4%（渐近最优，Alon & Klartag 2017 下界）
- 随机矩阵：存 8-byte 种子，运行时 PRNG + Gram-Schmidt 重建

#### 理论分工

| 理论 | 用在哪 | 作用 |
|------|--------|------|
| **TurboQuant** 残差版本链 | 记忆内容管理 | #base + →Δ，语义层版本控制 |
| **RaBitQ** 1-bit 量化 | 向量索引压缩 | 28x 压缩 + popcount，向量层存储优化 |
| 极坐标分解 | 不单独实施 | RaBitQ 已隐含（幅度 float32 + 方向 1-bit） |

#### L0/L1/L2 × 向量检索对齐

```
L0 概览   → centroid 向量 → 粗筛类别（20 次 float32）
L1 Top 3  → int8/RaBitQ  → 快速排序（量化距离）
L2 Top 10 → float32 原始  → 精确重排 + MMR + LLM 重排
```

---

## 三项目持续跟踪

| 项目 | 仓库 | 关注点 | 最后检查 |
|------|------|--------|---------|
| **QMD** | github.com/tobi/qmd | 新搜索算法、重排模型升级、MCP 协议扩展 | 2026-03-29 |
| **OpenViking** | github.com/volcengine/OpenViking | L0/L1 生成优化、新 scope 设计、性能报告 | 2026-03-29 |
| **lossless-claw** | github.com/martian-engineering/lossless-claw | DAG 压缩策略改进、新 Agent 工具、SQLite 优化 | 2026-03-29 |

### 跟踪机制

建议加入 `/github-radar` 或 insights 定时任务：
- 每周检查三个仓库的 release / 重要 commit
- 有新特性时自动生成简报到 RECENT_EVENTS
- 人工判断是否值得吸收到 backlog

### 已知的上游动态（截至 2026-03-29）

- **QMD v2.0.1**：当前最新版。重点关注 reranker 模型是否有更轻量的替代
- **OpenViking**：字节开源不久，迭代活跃。重点关注 L0/L1 自动生成是否有新方案
- **lossless-claw**：168 commits，活跃开发中。重点关注 FTS5 全文搜索是否正式集成
