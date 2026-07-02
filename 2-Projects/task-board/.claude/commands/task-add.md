---
description: 向本地任务看板新增一个任务
---

# 新增任务

参数：$ARGUMENTS（任务标题与详情）

请按以下步骤操作：

1. 读取 `task-board/tasks.json`
2. 生成下一个自增 id（在现有最大 `T-xxx` 基础上 +1）
3. 新建任务对象：
   - `title`：用户描述
   - `status`：默认 `todo`；用户说"以后再做 / 想法"则 `backlog`；用户说"现在就开始"则 `doing`
   - `priority`：用户指定则填，否则 `P2`
   - `project`：用户指定则填
   - `files`：已知关联文件则填
   - `notes`：可选补充
4. 写回 `tasks.json`，更新 `updatedAt`
5. 运行 `node task-board/scripts/sync-taskboard.mjs` 生成 `tasks.md`
6. 告诉用户新任务的 id
