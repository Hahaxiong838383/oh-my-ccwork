---
name: task-board
description: 本地多项目任务看板维护技能。当用户提出开发、修复、重构、写文档、生成页面等任务，或提到任务/看板/进度/项目/todo/done/doing 时使用。通过 HTTP API 维护 task-board/tasks.json（v2 多项目结构），状态变化自动同步到看板页面与 tasks.md。
---

# 本地任务看板维护规则

本技能维护本目录下的本地**多项目**任务看板。看板由三部分组成：

- `tasks.json`：唯一数据源（v2 结构，含多个 project）
- `index.html`：交互式看板页面（端口 8788）
- `tasks.md`：派生的人类可读清单（自动生成，勿手改）

## v2 数据结构（重要）

`tasks.json` 是**多项目**结构：

```jsonc
{
  "version": 2,
  "updatedAt": "...",
  "currentProject": "local-board",
  "projects": {
    "local-board": { "name": "看板本体", "color": "#6366f1", "tasks": [...] },
    "my-app":      { "name": "我的应用", "color": "#10b981", "tasks": [...] }
  }
}
```

- **任务 ID 按项目自增**：每个项目内独立从 `T-001` 起编号
- 所有任务 API 默认作用于 `currentProject`
- 读取旧版（v1）数据时，lib 会自动迁移，**无需手动处理**

## 触发时机

当用户提出以下类型任务时，**必须**使用本技能：

- 创建新功能 / 修复 bug / 重构代码
- 修改页面 / 生成文档 / 处理待办事项
- 用户明确提到任务、看板、进度、项目、 todo 、 done 、 doing

## 同步方式：优先用 curl 调 API

看板后端（`server.mjs`，默认端口 8788）提供 REST API。**首选 curl 调用**。

### 项目 API

```bash
# 列出所有项目（含当前项目）
curl http://localhost:8788/api/projects

# 新建项目并切到它
curl -X POST http://localhost:8788/api/projects \
  -H 'content-type: application/json' \
  -d '{"id":"my-app","name":"我的应用","color":"#10b981"}'

# 重命名 / 改色
curl -X PATCH http://localhost:8788/api/projects/my-app \
  -H 'content-type: application/json' -d '{"name":"新名字"}'

# 切换当前项目（返回 followUps = 切换前 doing 任务，用于复制跟进）
curl -X POST http://localhost:8788/api/projects/my-app/activate

# 删除项目（任务一并删）
curl -X DELETE http://localhost:8788/api/projects/my-app
```

### 任务 API（作用于当前项目）

```bash
# 当前项目的任务
curl http://localhost:8788/api/tasks

# 新建（id 在当前项目内自增，无需传 id）
curl -X POST http://localhost:8788/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"任务标题","status":"doing","priority":"P1","notes":"备注","files":["a.js"]}'

# 部分更新
curl -X PATCH http://localhost:8788/api/tasks/T-001 \
  -H 'content-type: application/json' -d '{"status":"done","notes":"已完成"}'

# 删除
curl -X DELETE http://localhost:8788/api/tasks/T-001

# 复制任务到其它项目（原任务保留，目标项目生成新任务，状态重置 todo）
curl -X POST http://localhost:8788/api/tasks/T-002/copy-to/my-app
```

### 回退方案（仅当 API 不通时）

server.mjs 未启动时，直接读写 `tasks.json`（保证 JSON 合法 + v2 结构），改完跑：

```bash
node scripts/sync-taskboard.mjs
```

## 字段与状态规则

任务字段：`title`(必) / `status` / `priority`(P1/P2/P3) / `project` / `files` / `notes`。

状态只允许：`backlog` / `todo` / `doing` / `done`。

## 必须更新任务的时机

1. **开始处理一个明确任务**：POST 新建或 PATCH 改为 `doing`
2. **完成任务**：PATCH 改为 `done`，补 `files`，`notes` 写完成情况
3. **任务被阻塞**：保持 `doing`，`notes` 写阻塞原因
4. **新增想法但不立即做**：POST 新建，`status=backlog`

## 多项目协作规则

- 接到任务时，先确认它属于哪个项目；若不在当前项目，先 `activate` 切过去
- 跨项目跟进同一件事：用 `copy-to` 复制（原项目保留，目标项目生成新任务）
- 切换项目时后端会返回 `followUps`（切换前的 doing 任务），需要的话主动复制

## 结束前检查

- 当前任务在 `tasks.json` 中已 `done`
- 已记录改动文件
- 任务归属于正确的项目
- API/同步未报错
