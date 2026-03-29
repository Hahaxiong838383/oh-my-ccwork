# 三项目研究对比

> 2026-03-29 完成研究。后续不需要再读仓库，本文件是完整提炼。

---

## QMD — 本地混合搜索引擎

**仓库**：github.com/tobi/qmd | TypeScript | MIT | Node.js ≥22

### 定位
本地优先的知识库搜索引擎。隐私第一，所有模型本地运行，不发送数据到云端。

### 核心架构：5 阶段搜索管线

```
1. 查询扩展 → LLM 生成 2 个语义变体（共 3 条查询）
2. 并行检索 → 每条查询同时跑 BM25 + 向量搜索
3. RRF 融合 → Reciprocal Rank Fusion 合并结果
   - 位置加分：#1 +0.05，#2-3 +0.02
   - 第一条查询 2x 权重
4. LLM 重排 → 本地模型对 Top 30 候选打分（yes/no + 置信度）
5. 结果编译 → 最终排序 + 可选的分数解释
```

### 我们吸收的

| 特性 | 用在哪 | 为什么 |
|------|--------|--------|
| **RRF 融合** | context-loader 三路检索合并 | 比简单 union 去重有理论支撑，位置信息不丢失 |
| **查询扩展** | 飞书短消息（"卡片报错"）→ 扩展召回面 | 可选，依赖 Ollama |
| **LLM 重排** | MMR 后二次过滤 | P2，需要 reranker 模型 |
| **分数解释** | 检索轨迹输出 | 调试"为什么没召回" |

### 我们不用的

- AST 分块（mycc 记忆不是代码）
- MCP 服务器模式（mycc 已有自己的后端）
- 独立 SQLite 索引（mycc 用 JSON 向量索引够了）

### 技术细节备查

- 模型缓存：`~/.cache/qmd/models/`（EmbeddingGemma-300M ~300MB、Qwen3-Reranker ~640MB、Query Expansion 1.7B ~1.1GB）
- 分块策略：~900 token/chunk + overlap
- RRF k 值：60（学术标准）
- 三种搜索命令：`search`（BM25）/ `vsearch`（向量）/ `query`（混合+重排）

---

## OpenViking — Agent 上下文数据库

**仓库**：github.com/volcengine/OpenViking | Python+Go+Rust | Apache 2.0 | 字节跳动

### 定位
用"文件系统范式"统一管理 Agent 的所有上下文（记忆、资源、技能）。不是向量数据库，是上下文数据库。

### 核心架构

```
viking://{scope}/{path}     ← 统一 URI 协议
     │
     ├── resources/  长期独立资源（全局可见）
     ├── user/       用户级数据（跨 session）
     ├── agent/      Agent 学到的技能和案例
     ├── session/    会话临时数据
     ├── queue/      内部处理队列
     └── temp/       临时文件
```

**L0/L1/L2 三层渐进加载**（核心创新，token 降 91%）：

| 层级 | token 预算 | 内容 | 生成方式 |
|------|-----------|------|---------|
| L0 | ~100 token | 超短摘要 | 从 L1 提炼 |
| L1 | ~1-2k token | 综合概览 | 从 L2 原文 LLM 生成 |
| L2 | 完整 | 原始内容 | 原文 |

**检索管线**：
1. 意图分析（LLM 检查查询 + 会话压缩 + 最近 5 条消息）
2. 查询生成（0-5 条 TypedQuery：Skill/Resource/Memory）
3. 层次目录遍历（优先级队列 + 分数传播）
4. 重排

**记忆自进化**：自动从任务执行中提取偏好、实体、事件、模式、案例。

### 我们吸收的

| 特性 | 用在哪 | 为什么 |
|------|--------|--------|
| **L0/L1/L2 渐进加载** | memory-items 按类别三级摘要 | token 节省显著 |
| **scope 隔离** | 新增 [agent/*] [session/*] | 技能记忆和会话事实需要独立管理 |
| **透明检索轨迹** | 检索过程可观测 | 调试 + insights 分析 |

### 我们不用的

- viking:// URI 协议（改造成本 > 收益）
- AGFS 分布式后端（单机够用）
- 加密/多租户（单用户）
- Volcengine 云服务集成

### 技术细节备查

- 默认端口：1933
- 配置文件：`~/.openviking/ov.conf`（JSON）
- 依赖 Python 3.10+、Go 1.22+、C++17 编译器
- 性能数据：LoCoMo10 测试集 1540 case，baseline +43%，token -91%

---

## lossless-claw — OpenClaw 无损上下文管理

**仓库**：github.com/martian-engineering/lossless-claw | TypeScript | MIT | Node.js ≥22

### 定位
OpenClaw 的上下文引擎插件。用 DAG 层次摘要替代滑动窗口，保证对话历史零丢失。

### 核心架构

```
对话消息流
    │
    ▼ 全部持久化到 SQLite
    │
    ▼ 达到 contextThreshold（默认 0.75）时触发压缩
    │
    ├── 叶子摘要（每 ~20k token 一组）
    │       │
    ├── 中间摘要（合并叶子）
    │       │
    └── 根摘要（最顶层）
           │
     DAG 结构（非线性，可回溯）
```

**三个 Agent 工具**：

| 工具 | 用途 |
|------|------|
| `lcm_grep` | 搜索历史消息 |
| `lcm_describe` | 获取某段历史的描述 |
| `lcm_expand` | 从摘要展开到细节（关键能力） |

### 我们吸收的

| 特性 | 用在哪 | 为什么 |
|------|--------|--------|
| **DAG 层次摘要** | chat-memory 摘要重写 | 比扁平摘要保留更多结构 |
| **expand 回溯** | 从摘要定位到原文 | 当前 chat-memory 的摘要不可展开 |
| **会话过滤 glob** | 排除定时任务等低价值对话 | 减少噪音 |
| **压缩阈值触发** | 替代/补充定时清理 | 按需压缩比定时更精准 |

### 我们不用的

- OpenClaw 插件机制（mycc 不是 OpenClaw）
- SQLite 全消息持久化（chat-history 按日归档够用）
- TUI 可视化（场景不匹配）

### 技术细节备查

- 压缩阈值：`contextThreshold = 0.75`（context 占比达 75% 触发）
- 尾部保护：`freshTailCount = 32`（最近 32 条消息不压缩）
- 叶子目标：`LEAF_TARGET_TOKENS = 1200`（每个叶子摘要 ~1200 token）
- 中间目标：`CONDENSED_TARGET_TOKENS = 2000`
- 排除模式：`ignoreSessionPatterns: ["agent:*:cron:**"]`

---

## 三项目对比总表

| 维度 | QMD | OpenViking | lossless-claw |
|------|-----|-----------|---------------|
| 解决什么 | 知识检索 | 统一上下文管理 | 对话上下文压缩 |
| 核心创新 | 5 阶段混合搜索管线 | L0/L1/L2 渐进加载 | DAG 无损摘要 |
| 语言 | TypeScript | Python+Go+Rust | TypeScript |
| 独立运行 | ✅ | ✅ | ❌（需 OpenClaw） |
| 本机可部署 | ✅（Node 22） | ❌（Python 3.10+） | ❌（需 OpenClaw） |
| 我们采纳比例 | ~40%（管线设计） | ~30%（加载+scope） | ~30%（DAG+过滤） |
