---
name: github-radar
description: GitHub AI 风向标 - 每日23:30抓取近7天热点开源项目（AI Agent、多智能体、记忆系统、Skills框架），发飞书日报。触发词："/github-radar"、"GitHub风向标"、"AI开源日报"
---

# GitHub AI 风向标

## 执行流程（两步）

### Step 1：抓取数据

```bash
python3 .claude/skills/github-radar/scripts/github-radar.py
```

数据保存到 `/tmp/github-radar-data.json`。

### Step 2：cc 分析 + 发送飞书日报

读取 `/tmp/github-radar-data.json`，按以下格式组织报告内容，**加入 cc 自己的判断**：

```
━━━━━━━━━━━━━━━━
🤖 AI Agent
  ★12.3k  microsoft/autogen
          多智能体对话框架

🔗 多智能体编排
  ★8.5k   crewAI/crewAI
          ...

🧠 记忆系统
  ...

⚡ Skills/工具框架
  ...

━━━━━━━━━━━━━━━━
共 12 个活跃项目 | 近7天更新

🧬 cc 的判断：对自进化有帮助的项目
  - [项目名]：理由（如：记忆架构、工具框架、MCP集成等方向）
  - ...
```

**cc 自进化判断标准**：
- 记忆系统/持久化：帮助 cc 跨会话保留知识
- 工具框架/MCP：扩展 cc 可调用的能力范围
- 多智能体编排：提升 cc 与其他 Agent 协作能力
- Skill 系统：与 mycc skills 架构高度相关的

然后通过 tell-me 发送飞书通知：

```bash
node .claude/skills/tell-me/send.js "GitHub AI 风向标 $(date +%Y-%m-%d)" "报告内容"
```

### Step 3：升级建议通知（独立发一条）

在日报发完后，对比当前已有 skill 列表，额外发一条升级建议：

**对比维度**：
- 当前已有 skill：`agent-orchestration`, `mem0-patterns`, `configure-ecc`, `browser-use`（如有）等
- 发现的新项目是否与现有 skill 重叠？是否填补空白？是否有架构升级价值？

**建议等级**：
- 🔴 强烈建议升级：新架构/新范式，现有 skill 已落后
- 🟡 可以考虑：补充现有 skill 的空白
- ⚪ 暂不需要：与现有 skill 重叠，或与技术栈不符

**发送格式**：
```bash
node .claude/skills/tell-me/send.js \
  "🧬 cc 自进化建议 MM-DD" \
  "━━━━━━━━━━━━━━━━\n🧬 cc 每日自进化检查\n━━━━━━━━━━━━━━━━\n\n📦 今日发现的升级候选：\n\n🟡 项目名 ★Xk\n  理由：...\n  建议：...\n\n⚪ 项目名 ★Xk\n  已有 skill 覆盖，暂不需要\n\n━━━━━━━━━━━━━━━━\n💬 说\"升级 [项目名]\"告诉我要不要装" \
  green
```

## 监控分类

| 分类 | 关注方向 |
|------|---------|
| 🤖 AI Agent | 单 Agent 框架、LLM 工具调用 |
| 🔗 多智能体编排 | Multi-Agent、swarm、协作框架 |
| 🧠 记忆系统 | Agent 记忆、向量存储、上下文管理 |
| ⚡ Skills/工具框架 | Agent 工具箱、skill 系统、MCP 相关 |

## 数据说明

- **数据源**：GitHub Search API（免费，无需 token，10次/分钟限制）
- **筛选条件**：近7天有 push 活动，stars 达到各分类阈值
- **每分类**：展示 top 3 项目
- **rate limit 规避**：每次查询之间 sleep 1s
- **中间文件**：`/tmp/github-radar-data.json`

## 调度配置

- 时间：每日 23:30（北京时间）
- 触发：scheduler tasks.md
