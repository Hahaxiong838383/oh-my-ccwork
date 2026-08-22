---
name: opencli-autofix
description: Automatically fix broken OpenCLI adapters when commands fail. Load this skill when an opencli command fails — it guides you through diagnosing the failure via OPENCLI_DIAGNOSTIC, patching the adapter, retrying, and filing an upstream GitHub issue after a verified fix. Works with any AI agent.
allowed-tools: Bash(opencli:*), Bash(gh:*), Read, Edit, Write
---

# opencli-autofix（多引擎入口）

本 Skill 的单一真源是：

`../../../.claude/skills/opencli-autofix/SKILL.md`

执行相关工作前，先完整读取该文件，并按其中的流程、约束与验收口径执行。
不要在本入口复制正文，避免多引擎版本漂移。
