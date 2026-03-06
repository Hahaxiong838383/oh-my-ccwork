---
name: github-radar
description: GitHub AI 风向标 - 每日23:30抓取近7天热点开源项目（AI Agent、多智能体、记忆系统、Skills框架），发飞书日报。触发词："/github-radar"、"GitHub风向标"、"AI开源日报"
---

# GitHub AI 风向标

## 执行流程

```bash
python3 .claude/skills/github-radar/scripts/github-radar.py
```

## 监控分类

| 分类 | 关注方向 |
|------|---------|
| 🤖 AI Agent | 单 Agent 框架、LLM 工具调用 |
| 🔗 多智能体编排 | Multi-Agent、swarm、协作框架 |
| 🧠 记忆系统 | Agent 记忆、向量存储、上下文管理 |
| ⚡ Skills/工具框架 | Agent 工具箱、skill 系统、MCP 相关 |

## 报告格式

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
```

## 数据说明

- **数据源**：GitHub Search API（免费，无需 token，10次/分钟限制）
- **筛选条件**：近7天有 push 活动，stars 达到各分类阈值
- **每分类**：展示 top 3 项目
- **rate limit 规避**：每次查询之间 sleep 1s

## 调度配置

- 时间：每日 23:30（北京时间）
- 触发：scheduler tasks.md
