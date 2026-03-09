---
name: multi-session
description: 自动创建多个独立的 Claude Code 终端窗口，每个窗口有独立的 session 和 memory，支持多任务并行执行
trigger: 多窗口|并行任务|开多个|多会话
---

# Multi-Session Skill

自动创建多个独立的 Claude Code 终端窗口，每个窗口有独立的 session 和 memory。

## 使用方式

```
/multi-session 3
/multi-session 5
```

## 功能

1. **自动创建终端窗口** - 使用 `open -n -a Terminal` 打开新窗口
2. **独立 session** - 每个窗口是完全独立的 Claude Code session
3. **独立 memory** - 每个窗口有独立的上下文，不会互相干扰

## 实现

### 打开指定数量的窗口

```bash
# 开启 3 个窗口
open -n -a Terminal
open -n -a Terminal
open -n -a Terminal
```

### 在新窗口中启动 Claude Code

在新打开的终端中输入：
```bash
claude
```

## 完整示例

```
/multi-session 3
```

效果：自动打开 3 个新的终端窗口，你可以在每个窗口输入 `claude` 启动独立会话。

## OMC 替代方案

如果觉得开多个窗口麻烦，可以使用 OMC 的 `/team` 模式在单个窗口内实现多任务并行：

```
/team 5 "并行修复所有错误"
```

## 可用命令

| 命令 | 说明 |
|------|------|
| `/team N 任务` | N 个 agent 协同 |
| `ulw 任务` | 最大并行化 |
| `ralph: 任务` | 持久模式 |

## 注意事项

- 每个窗口消耗独立的 Claude API token
- 建议根据任务复杂度选择窗口数量
- 复杂任务可用 OMC 的 `/team` 模式代替
