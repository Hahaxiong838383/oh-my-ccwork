# memory-v5 — 记忆系统 v5 升级（代号 Viking-Claw）

> 将 QMD / OpenViking / lossless-claw 三项目的精华整合到 mycc 现有记忆架构中。
> 状态：**P0/P1/P2 全部完成，版本 v5.5**

## 一句话

在 v4（TurboQuant：残差版本链 + 向量语义检索 + 分层失真预算）基础上，吸收三个开源项目的核心设计，升级检索管线、渐进加载、对话压缩。

## 当前状态

| 阶段 | 状态 | 说明 |
|------|------|------|
| 研究三项目 | ✅ 完成 | QMD / OpenViking / lossless-claw 已完成分析 |
| 差距分析 | ✅ 完成 | 7 项改进点已识别，按 P0/P1/P2 排优先级 |
| P0 实施 | ✅ 完成 | RRF 融合 + 检索轨迹 + 会话过滤 |
| P1 实施 | ✅ 完成 | L0 渐进加载 + agent scope 扩展 |
| P2 实施 | ✅ 完成 | DAG 对话摘要 + LLM 重排（Qwen3-Reranker-0.6B） |

## 关键文件

| 文件 | 用途 |
|------|------|
| `README.md` | 本文件，项目总览和当前状态 |
| `HANDOFF.md` | **跨 session 交接文档**（新 session 必读） |
| `research.md` | 三项目研究对比 |
| `plan.md` | 升级方案详细设计 |
| `decisions.md` | 过程中的技术决策记录 |
| `backlog.md` | 跟踪候选特性 + 三项目持续关注（SQLite 等后续需求） |

## 核心代码位置

升级涉及的所有代码都在 mycc 后端：

```
.claude/skills/mycc/scripts/src/services/
├── context-loader.ts    # P0: RRF融合、检索轨迹 / P1: L0/L1/L2
├── embedding.ts         # P2: LLM 重排（如需）
├── chat-memory.ts       # P0: 会话过滤 / P2: DAG 摘要
└── auto-capture.ts      # P1: scope 扩展适配
```

记忆数据文件：

```
0-System/
├── memory-items.md      # P1: 新增 [agent/*] [session/*] scope
├── memory-vectors.json  # 索引随 items 变更重建
└── trajectories/        # P0: 新增 recall-*.jsonl 检索轨迹
```

## 设计文档位置

架构认知沉淀在：`3-Thinking/05-记忆认知自进化架构.md`
