# 跟踪候选（Backlog）

> 当前优先级不高但后续会用到的特性。P0/P1/P2 完成后回来评估。
> 同时跟踪三个参考项目的更新，有新特性随时分析。

---

## 候选特性

| ID | 特性 | 来源 | 当前不做原因 | 何时重新评估 | 状态 |
|----|------|------|-------------|-------------|------|
| B01 | **SQLite 全消息持久化** | lossless-claw | chat-history 按日归档暂够用 | P2 DAG 摘要实施时（DAG 天然适配 SQLite 存储） | ⬜ 候选 |
| B02 | **AST 感知分块** | QMD | 当前记忆是自然语言 Item | 接入代码仓库检索时（如 mycc-web 代码） | ⬜ 候选 |
| B03 | **viking:// URI 统一寻址** | OpenViking | 改造成本 > 收益 | 多 Agent 协作场景（cc+codex+gemini 共享上下文）| ⬜ 候选 |
| B04 | **AGFS 分布式后端** | OpenViking | 单机运行够用 | 多设备同步需求增长时（NAS↔MacBook↔远程 Mac） | ⬜ 候选 |
| B05 | **加密存储** | OpenViking | 单用户无安全风险 | 对外开放 mycc 服务时 | ⬜ 候选 |
| B06 | **多租户隔离** | OpenViking | 单用户 | 多用户/多 Agent 场景 | ⬜ 候选 |

### B01 详细规划（SQLite，优先级最高）

**为什么后续会需要**：
1. DAG 摘要（P2-6）的节点关系用 JSON 文件存不够灵活，SQLite 天然支持关系查询
2. 检索轨迹（P0-2）的 JSONL 随时间增长需要索引，SQLite FTS5 比逐行扫描快很多
3. memory-items 当前 274 条，增长到 1000+ 时 JSON/Markdown 解析性能会成瓶颈
4. lossless-claw 的 SQLite 方案已验证可行（168 个测试用例）

**预期实施时机**：P2 阶段或 memory-items 突破 500 条时

**迁移路径**：
```
memory-items.md → SQLite items 表（保留 md 文件作为人类可读备份）
memory-vectors.json → SQLite vectors 表（sqlite-vec 扩展）
chat-memory/*.json → SQLite conversations 表 + dag_nodes 表
trajectories/*.jsonl → SQLite traces 表（FTS5 全文索引）
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
