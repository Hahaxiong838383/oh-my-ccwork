# 归档：OMC 多会话并行参考

> 从 CLAUDE.md 归档于 2026-03-19。最新版多智能体协同规则见 `multi-agent/RULES.md`。

# OMC (oh-my-claudecode) 多会话并行

> Claude Code 的多智能体编排系统，支持多窗口并行运行多任务。

## 安装与更新

```bash
# 安装
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode

# 更新
/plugin marketplace update omc
/omc:omc-setup
```

## 核心模式

| 模式 | 命令 | 适用场景 |
|------|------|---------|
| **autopilot** | `autopilot: 任务` | 全自动工作流 |
| **team** | `/team N 任务` | N 个 agent 协同 |
| **ralph** | `ralph: 任务` | 持久模式，必须完成 |
| **ultrawork** | `ulw 任务` | 最大并行化 |
| **ultrapilot** | - | 3-5倍速多组件系统 |
| **swarm** | `/swarm N 任务` | 并行独立任务 |

## 多窗口并行

当需要多个独立 Claude Code 窗口时：

```bash
# 终端1
claude

# 终端2
claude

# 终端3
claude
```

或使用 OMC team 模式：
```
/team 5 "并行修复所有 TypeScript 错误"
```

## 32 个专业 Agent

| Agent | 用途 |
|-------|------|
| planner | 实现规划 |
| architect | 系统设计 |
| executor | 代码执行 |
| code-reviewer | 代码审查 |
| security-reviewer | 安全审查 |
| build-fixer | 构建修复 |
| debugger | 调试分析 |
| designer | UI/UX 设计 |
| scientist | 数据分析 |
| test-engineer | 测试工程 |

---
