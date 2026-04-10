---
name: codex-adversarial-review
description: 让 Codex 对代码进行对抗性审查，挑战实现方式和设计决策。当用户提到让 codex 挑毛病、找问题、对抗审查、质疑设计时触发。触发词包括 "/codex-adversarial-review"、"codex 对抗审查"、"让 codex 挑毛病"、"找 codex 质疑一下"
---

# codex-adversarial-review — Codex 对抗性代码审查

调用 Codex 对代码进行对抗性审查：不仅检查实现缺陷，更质疑设计选择、权衡取舍和隐含假设。

## 触发词

精确匹配：
- "/codex-adversarial-review"

意图匹配（包含以下任意关键词组合即触发）：
- codex + 对抗审查/adversarial/挑毛病/找茬/质疑/挑战
- 让/找/用 + codex + 挑/质疑/挑战/怼一下
- "codex 帮忙挑挑毛病"、"让 codex 质疑一下这个设计"、"找 codex 对抗审查"

## 参数

| 参数 | 说明 |
|------|------|
| `--wait` | 前台等待结果 |
| `--background` | 后台运行 |
| `--base <ref>` | 指定对比基准分支 |
| `--scope auto\|working-tree\|branch` | 审查范围 |
| `[focus ...]` | 额外的聚焦文本，指定审查重点（如 "关注并发安全"） |

## 审查攻击面优先级

1. 认证、权限、租户隔离、信任边界
2. 数据丢失、损坏、重复
3. 回滚安全、重试、幂等性
4. 竞态条件、过期状态
5. 空状态、null、超时行为
6. 版本偏差、迁移、兼容性
7. 可观测性盲区

## 执行步骤

1. 定位插件运行时：

```bash
CODEX_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/openai-codex/codex/* 2>/dev/null | sort -V | tail -1)"
```

2. **如果用户未指定 `--wait` 或 `--background`**，评估审查规模（同 codex-review），询问用户选择前台或后台。

3. **前台执行**：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" adversarial-review "$ARGUMENTS"
```

4. **后台执行**：

```bash
# 使用 run_in_background: true
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" adversarial-review "$ARGUMENTS"
```
后台启动后告知用户：「Codex 对抗审查已在后台启动，用 `/codex-status` 查看进度。」

5. **结果展示**：原样返回 Codex 输出。

## 铁律

- **仅审查，不修复**。展示完发现后 STOP，必须征得用户同意才能动代码。
- **原样输出**。不要改写、总结。
- 只报告实质性发现（material findings），不报告风格/命名类意见。
