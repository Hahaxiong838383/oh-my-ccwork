# Claude Code 源码架构分析

> 基于 Hahaxiong838383/claude-code-source (v2.1.88) 反编译源码

## 四维度深度拆解

### 1. Agent Team（多代理编排）

**混合编排模型**：Coordinator + Swarm

- 三种执行后端：InProcess（同进程 AsyncLocalStorage）、Tmux（独立进程）、iTerm2（macOS 原生）
- 通信：文件信箱 `~/.claude/teams/{team}/inboxes/{agent}.json` + proper-lockfile 并发安全
- 权限委托链：Worker → 信箱请求 → Leader UI 确认 → 信箱响应 → Worker 继续
- Hook 事件：SubagentStart / SubagentStop / TeammateIdle

### 2. 组织记忆层

**三作用域记忆**：
- Managed → User → Project → Team（云同步）→ Agent（per-type）

**Session Memory 自动提取**（核心机制）：
- postSamplingHook 每次 API 响应后触发
- 三阈值：context > 10k tokens + tool calls >= 3 + 安全点检测
- fork 子 agent 后台提取，不阻塞主对话
- 模板：10 个固定 section（Session Title / Current State / Files / Errors / Learnings ...）

**Team Memory 云同步**：
- 按 git remote 隔离，ETag 增量同步
- Server 权威，冲突时 server wins

### 3. 留存与陪伴

**Buddy 系统**：纯装饰性 ASCII 精灵，种子随机生成，增加情感连接
**Dream 任务**：后台记忆巩固子 agent，审查近期 session 提取知识
- 门控：24h 时间门 + 5 session 数量门 + 锁防并发

### 4. 持续助手

**Bridge Daemon**：CLI ↔ WebSocket ↔ 网页 双向同步
- 32 并行 session，自动重连，超时看门狗
- Capacity Wake：新任务自动唤醒空闲 session

**Session Resume**：完整状态重建（消息历史 + 文件快照 + Todo + 权限上下文 + worktree）

## mycc 可借鉴的优化点

| 排名 | 机制 | 原因 | 状态 |
|------|------|------|------|
| 1 | Session Memory 自动提取 | 解决最大痛点：手动提取→信息丢失 | 实施中 |
| 2 | Dream 后台记忆巩固 | 实现计划中的 04:00 自动整理 | 实施中 |
| 3 | Agent 独立记忆 | cc/codex/gemini 各自积累经验 | 实施中 |
| 4 | Skill 热发现 | 按需加载 tool schema，节省 token | 待评估 |
| 5 | Hook 事件细化 | SubagentStart/Stop 可观测性 | 待评估 |
| 6 | 定时任务加锁+防抖 | 防止 scheduler 重复执行 | 待评估 |

## mycc 差异化优势（保持）

1. 检索质量：RRF + 向量 + TF-IDF >>> 官方纯文本截断
2. 认知框架：6 理论映射 >>> 官方无理论工程
3. 多引擎异构：cc + codex + gemini >>> 同模型多实例
4. 语义轨迹：friction 检测 + 因果链 >>> OpenTelemetry 数值
