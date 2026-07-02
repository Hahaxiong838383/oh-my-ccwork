---
description: 将指定任务标记为已完成
---

# 完成任务

参数：$ARGUMENTS（任务 id 或标题关键词）

请按以下步骤操作：

1. 读取 `task-board/tasks.json`
2. 根据 id 或标题关键词匹配到目标任务
3. 将其 `status` 改为 `done`
4. 更新 `notes`，记录完成情况
5. 补充 `files`（本次实际改动的文件）
6. 写回 `tasks.json`，更新 `updatedAt`
7. 运行 `node task-board/scripts/sync-taskboard.mjs` 生成 `tasks.md`
8. 向用户确认已完成
