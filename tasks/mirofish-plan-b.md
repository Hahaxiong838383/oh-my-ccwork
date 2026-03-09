# Plan B：Theory-Radar GraphRAG 增强

> 状态：待执行（Plan A + C 完成后的下一步）
> 来源：MiroFish 技术借鉴，2026-03-08 规划
> 执行方式：三机器人群聊，cc 主导，codex 实现，gemini 验证

---

## 背景

MiroFish 的 GraphRAG 技术可以把孤立的论文变成知识图谱，让 theory-radar 从「新闻聚合」升级为「知识演化追踪」。

## 目标

- 论文之间建立关联边（引用关系 + 概念重叠 + 同作者）
- 飞书日报新增「知识图谱热点」区块：新兴方向 + 关键人物
- 存量论文不动，从今天起增量构建

## 技术方案

- 图存储：NetworkX（Python，无需新服务）
- 持久化：`tasks/theory-radar/graph.json`
- 相似度：arXiv abstract embedding（text-embedding-3-small）
- 增量更新：每日 run 时新增当日节点和边

## 三机器人分工

| 角色 | 任务 |
|------|------|
| cc | 架构设计、代码审查、最终集成确认 |
| codex | 实现 graph_builder.py（NetworkX 图构建 + 持久化） |
| gemini | 验证图结构正确性、设计测试用例、评审嵌入质量 |

## 协作流程

1. cc 在群里发布 SPEC（接口定义 + 验收条件）
2. codex 实现，gemini 同步出验收测试
3. codex 提交代码，gemini 跑测试验证
4. cc 裁决合并，集成到 theory-radar 定时任务

## 预计工作量

3-4 天（三机器人并行可缩短到 1-2 天）

---

**提醒川哥**：Plan A（pre-flight skill）和 Plan C（记忆时序化）都完成了，可以启动这个了！
说「开始 Plan B」或「在群里发动 codex 和 gemini 做 GraphRAG」即可。
