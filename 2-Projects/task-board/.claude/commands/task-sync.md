---
description: 校验并同步本地任务看板数据
---

# 同步看板

请按以下步骤操作：

1. 运行 `node task-board/scripts/sync-taskboard.mjs`
2. 该脚本会：
   - 校验 `tasks.json` 中每个任务的字段和状态合法性
   - 更新 `updatedAt`
   - 重新生成 `tasks.md`
3. 如果校验失败，按错误信息修复 `tasks.json` 后重试
4. 向用户汇报当前各状态（backlog / todo / doing / done）的任务数量
