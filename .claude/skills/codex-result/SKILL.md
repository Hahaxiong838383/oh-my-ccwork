---
name: codex-result
description: 查看已完成的 Codex 任务的完整结果。当用户想看 codex 的输出、成果、做了什么时触发。触发词包括 "/codex-result"、"codex 结果"、"看看 codex 做了什么"、"codex 输出是什么"
---

# codex-result — Codex 任务结果

查看已完成的 Codex 任务的完整输出。

## 触发词

精确匹配：
- "/codex-result"

意图匹配：
- codex + 结果/输出/成果/做了什么/产出
- "看看 codex 做了啥"、"codex 的结果拿出来"、"codex 输出是什么"

## 参数

| 参数 | 说明 |
|------|------|
| `[job-id]` | 指定任务 ID（可选，不指定则显示最近的） |

## 执行步骤

1. 定位插件运行时：

```bash
CODEX_PLUGIN_ROOT="$(ls -d ~/.claude/plugins/cache/openai-codex/codex/* 2>/dev/null | sort -V | tail -1)"
```

2. 获取结果：

```bash
node "$CODEX_PLUGIN_ROOT/scripts/codex-companion.mjs" result "$ARGUMENTS"
```

3. **结果展示**：完整展示，不要总结或压缩。保留所有细节：
   - Job ID 和状态
   - 完整结果（verdict、summary、findings、details、artifacts、next steps）
   - 文件路径和行号原样保留
   - 错误信息或解析错误
   - 后续可用命令
