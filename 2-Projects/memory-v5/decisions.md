# 技术决策记录

> 格式：日期 | 决策 | 备选方案 | 选择原因

---

### D01 | 2026-03-29 | 不部署三项目，只吸收设计

**备选**：
- A. 部署三项目 + 通过 API 集成
- B. 只吸收设计，改自己的代码

**选择 B**，原因：
1. QMD 可部署（Node 22 ✅），但 mycc 不需要独立搜索服务，直接在 context-loader 里改更紧凑
2. OpenViking 需要 Python 3.10+（本机 3.9.6）、Go、Rust 编译链，部署成本高
3. lossless-claw 需要 OpenClaw 宿主，无法独立运行
4. 三项目的核心创新是**设计思想**（RRF/L0L1L2/DAG），不是代码实现

---

### D02 | 2026-03-29 | scope 扩展到 4 个而非 6 个

**OpenViking 6 scope**：resources / user / agent / session / queue / temp

**mycc 采用 4 个**：user / project / agent / session

**不要的**：
- `queue`：OpenViking 内部处理队列，mycc 不需要
- `temp`：临时文件，mycc 用 1-Inbox/ 代替

**新增的**：
- `[agent/*]`：cc 的技能记忆（已毕业规则、通用踩坑经验）
- `[session/*]`：当前会话临时事实（替代 chat-memory per-chat facts）

---

### D03 | 2026-03-29 | RRF k=60

QMD 使用 k=60，这是 Cormack et al. (2009) 的标准推荐值。

k 值的影响：
- k 越大 → 排名差异影响越小 → 更均匀
- k 越小 → Top 1 权重更大 → 更激进

60 是保守的起点。后续可通过检索轨迹数据调优。

---

### D04 | 2026-03-29 | L0 用统计方法生成，不用 LLM

**OpenViking 方案**：用 VLM（大语言模型）从 L2 内容生成 L0/L1 摘要。

**mycc 方案**：L0 用 TF-IDF 提取 Top 5 关键词 + 模板生成，L1 直接取 Top 3 高分 Item。

**原因**：
1. 避免引入 LLM 调用延迟
2. memory-items 本身就是原子事实，不需要"摘要的摘要"
3. 关键词 + 条目数已足够让 cc 判断"这个类别有没有用"

---

### D06 | 2026-03-29 | DAG 摘要不调 LLM，纯本地规则提取

**备选**：
- A. 用 LLM（Qwen2.5:3b）生成每个 chunk 的摘要
- B. 纯本地规则：用户问题拼接 + 末尾结论截取

**选择 B**，原因：
1. 保持 chat-memory 轻量原则一致（D04 同理）
2. `onSessionEnd` 是同步调用，引入 LLM 会增加延迟
3. DAG 的核心价值是**结构化回溯**（expand），不是摘要质量
4. 后续可升级为异步 LLM 摘要（在后台生成，不阻塞 session 结束）

---

### D08 | 2026-03-29 | SQLite 统一存储：md 为主源，SQLite 为派生索引

**核心决策**：md 文件保持人类可编辑的主数据源，SQLite 是自动重建的派生索引。

**备选**：
- A. SQLite 为唯一数据源（md 只读导出）
- B. md 为主源，SQLite 为派生索引（mtime 变更检测）

**选择 B**，原因：
1. 用户直接编辑 memory-items.md 是核心工作流，不能改变
2. NAS 同步走 git（同步 md 文件），SQLite 在各设备本地重建
3. md 保证 git diff 可读性和人工审查能力
4. 向量索引（memory-vectors.json）已用同样模式验证可行

---

### D09 | 2026-03-29 | 技术选型 better-sqlite3 + sqlite-vec

**选 better-sqlite3**：同步 API 与现有控制流完美匹配，无需 async 改造。
**选 sqlite-vec**：纯 C 扩展，原生 cosine KNN，通过 `.load()` 加载。
**不选 ORM**：只有 5 张表，裸 SQL 更直观。
**不选 sql.js**：纯内存，无持久化。
**不选 bun:sqlite**：仅 Bun 运行时，项目用 Node.js。

---

### D11 | 2026-03-29 | 查询扩展用 qwen2.5:3b（Ollama），不冲突 cc-eye

cc-eye 主力模型是 Qwen3.5-4B-MLX-4bit（oMLX 框架，端口 8000），与 Ollama（端口 11434）是独立进程。
qwen2.5:3b 仅作 cc-eye 降级方案（小概率），正常情况下查询扩展不影响语音交互。
扩展策略：短消息（4-200 字）生成 2 个语义变体，扩展后 TF-IDF 候选从 2 个扩到 4 个。

---

### D10 | 2026-03-29 | 过渡期双写（SQLite + 文件）

所有写入同时写 SQLite 和原文件，读取优先 SQLite 降级到文件。
过渡期结束后可移除文件写入，但 md 主源永远保留。

---

### D07 | 2026-03-29 | Reranker 批量评分（一次调用），权重 0.6:0.4

**设计**：一次 Ollama generate 调用，传入 query + 所有候选文档，模型输出分数数组。

**替代方案**：逐条调用 reranker（每条一次 RT）。

**选择批量**：
1. 10-20 条逐条调用 ≈ 10+ 秒，批量 ≈ 1 次 RT（<2 秒）
2. Qwen3-Reranker 支持多文档输入
3. 权重 0.6(rerank) : 0.4(原始) 来自 QMD 默认值，通过检索轨迹可后续调优

---

### D05 | 2026-03-29 | 项目文件放 2-Projects/memory-v5

**规则**：正在推进的项目放 `2-Projects/`。

**完成后**：
- 代码在 `.claude/skills/mycc/scripts/src/services/`（随 mycc 后端走）
- 架构文档更新 `3-Thinking/05-记忆认知自进化架构.md`
- 本目录归档到 `5-Archive/memory-v5/`

---

### D12 | 2026-03-30 | AutoResearch 能力引入：P0-P2 三层升级

**背景**：研究 karpathy/autoresearch(60.9k⭐)、codex-autoresearch、claude-autoresearch、AutoResearchClaw(9.5k⭐) 四个项目，提取可迁移到 cc 的能力。

**备选**：
- A. 直接部署 autoresearch 项目作为独立工具
- B. 提取核心模式，融入 cc 现有规则/skill/记忆体系
- C. 只做笔记，不实施

**选择 B**，原因：
1. autoresearch 核心价值是**设计模式**（自主迭代循环、渐进失败升级、双门验证、原子实验），不是代码实现
2. cc 已有 evolution-log + friction_skill + 记忆系统 v5.5，融合比独立部署更紧凑
3. 四个项目的 ML 训练场景不适用，但**迭代优化框架**是通用的

**三层实施**：
- P0：渐进式失败升级（rules/failure-escalation.md）+ 双门验证（rules/testing.md 追加）
- P1：`/autoresearch` skill + 原子实验协议（rules/atomic-experiments.md）
- P2：MetaClaw 自进化（`/metaclaw` skill + friction-patterns.md），从摩擦数据自动提取模式→生成反馈→注入未来行为

**放弃的方案**：
- A（独立部署）：增加维护负担，且 cc 不做 ML 训练
- C（不实施）：P0 几乎零成本，不做可惜

**什么条件下该翻**：
- 如果自进化循环产生噪音（误注入无效规则）→ 回滚 P2
- 如果 /autoresearch 长期无人使用 → 清理 P1
