---
name: codex-setup
description: 检查 Codex CLI 是否就绪，可选开启/关闭 stop-time review gate。触发词："/codex-setup"、"codex 设置"、"检查 codex"、"codex 装好了吗"、"codex 能用吗"
---

# codex-setup — Codex 环境检查与配置

检查本地 Codex CLI 是否已安装、已认证，可选切换 stop-time review gate。

## 触发词

- "/codex-setup"
- "codex 设置"、"检查 codex"、"codex ready"
- "codex 装好了吗"、"codex 能用吗"、"codex 就绪没"

## 参数

| 参数 | 说明 |
|------|------|
| `--enable-review-gate` | 启用 stop-time review gate（每次 session stop 前自动审查代码变更） |
| `--disable-review-gate` | 关闭 review gate |
| 无参数 | 仅检查 Codex 状态 |

## 执行步骤

1. 定位 Codex 插件运行时：

```bash
CODEX_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/openai-codex/codex/* 2>/dev/null | sort -V | tail -1)"
```

2. 运行检查：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

3. 根据结果处理：
   - **Codex 未安装且 npm 可用**：询问用户是否安装，若同意则执行 `npm install -g @openai/codex`，然后重新检查
   - **Codex 已安装但未认证**：提示用户运行 `! codex login --device-auth` 进行登录
   - **Codex 就绪**：展示状态信息

4. 向用户展示最终检查结果。
