---
name: codex-adversarial-review
description: Codex 对抗性审查。质疑实现方案、设计选择、权衡取舍和隐含假设，不仅是更严格的缺陷检查。触发词："/codex-adversarial-review"、"对抗审查"、"挑战代码"、"质疑设计"、"adversarial review"
layer: 分析层
authorization: A区（自动执行，不等人确认）
output_levels: L3（原样输出 Codex 结果）
---

# codex-adversarial-review — Codex 对抗性审查

> 挑战性审查：质疑实现方案是否正确、设计选择是否合理、假设在真实环境下是否成立。
> 不是更严格的缺陷扫描，而是从根本上质疑"这个方案对不对"。

## 触发词

- `/codex-adversarial-review`
- "对抗审查"、"挑战代码"、"质疑设计"、"adversarial review"
- "这个方案有什么问题"、"帮我找找设计缺陷"

---

## 全局默认配置（codex 优先要求）

**所有 codex-* skills 共享的强制默认值**，cc 不得擅自更改：

| 配置项 | 值 | 设置位置 | 覆盖方式 |
|--------|----|----|----|
| `model` | `gpt-5.4` | 命令行 `--model` + `~/.codex/config.toml` | 用户显式 `--model <other>` |
| `model_reasoning_effort` | `xhigh` | `~/.codex/config.toml` | 仅能改 config.toml |
| `service_tier` | `fast` | `~/.codex/config.toml` | 仅能改 config.toml |

**启动前自检**（任何 codex 调用第一次运行时跑一次）：

```bash
grep -E "^(model|model_reasoning_effort|service_tier)" ~/.codex/config.toml
```

期望输出：

```
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
service_tier = "fast"
```

缺失或漂移时，cc **必须先补齐 config.toml 再执行对抗审查**，并在输出中说明补齐动作。用户显式要求其他 model / effort 时才可偏离默认。

---

## 前置检查

```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" setup --json
```

如果 `ready: false`，提示用户先运行 `/codex:setup`。

---

## 核心约束

- **仅审查，不修复。** 不要修改代码。
- 保持对抗性视角：质疑选择、暴露假设、追踪失败路径。
- 将 Codex 输出**原样**返回。

---

## 审查攻击面

Codex 对抗性审查重点关注：

| 攻击面 | 关注点 |
|--------|--------|
| 认证/信任边界 | 权限绕过、令牌泄漏 |
| 数据丢失/损坏 | 并发写入、部分更新 |
| 回滚/幂等性 | 中断后的状态一致性 |
| 竞态条件 | 状态管理缺陷 |
| 空值/超时/降级依赖 | 异常路径处理 |
| 版本兼容性回归 | 升级后的破坏性变更 |
| 可观测性盲区 | 无法排查的故障 |

---

## 执行模式

用户可传入参数：`$ARGUMENTS`

支持的参数：
- `--wait`：前台执行
- `--background`：后台执行
- `--base <ref>`：指定基准分支
- `--scope auto|working-tree|branch`：审查范围
- 额外的 focus text（自由文本，描述关注重点）

### 模式选择

与 `/codex-review` 相同的规模估算逻辑。

---

## 前台执行

```bash
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" adversarial-review --model gpt-5.4 $ARGUMENTS
```

`--model gpt-5.4` 是全局优先默认值，用户 `$ARGUMENTS` 里显式再传 `--model <other>` 时以用户为准（parseArgs 后值覆盖前值）。

## 后台执行

```bash
# 使用 Bash 工具的 run_in_background: true
node "$HOME/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" adversarial-review --model gpt-5.4 $ARGUMENTS
```

启动后告知用户："Codex 对抗性审查已在后台启动。使用 `/codex-status` 查看进度。"

---

## 输出规则

- 保留所有 findings：severity、confidence、file path、line numbers、recommendation
- verdict 为 `needs-attention` 或 `approve`
- 展示后 **停止** — 不要在未经用户明确批准的情况下修改代码
