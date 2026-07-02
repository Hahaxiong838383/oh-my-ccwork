# AGENTS.md — Codex 接入说明

本仓库是一个**本地任务看板**，Codex 在此目录工作时必须维护它。

## 看板架构

- `tasks.json`：唯一数据源（**不要手改 `tasks.md`**，它是自动生成的）
- `index.html`：交互式看板页面（拖拽 + 按钮 + 全字段编辑）
- `server.mjs`：零依赖 HTTP 服务，提供 REST API（默认端口 **8788**）
- `scripts/lib.mjs`：读写/校验核心逻辑
- `scripts/sync-taskboard.mjs`：命令行同步工具（校验 + 生成 `tasks.md`）

## Codex 的工作规则

### 1. 任务维护（强制）

接受任何开发类任务（新增功能 / 修 bug / 重构 / 改页面 / 写文档）时，**必须**同步维护看板：

| 时机 | 动作 |
|---|---|
| 开始一个明确任务 | 新建或把任务置为 `doing` |
| 完成任务 | 置为 `done`，记录改动的 `files`，`notes` 写完成情况 |
| 被阻塞 | 保持 `doing`，`notes` 写阻塞原因 |
| 用户提想法但不立即做 | 新建，状态 `backlog` |

### 2. 多项目结构（v2）

`tasks.json` 是多项目结构：`projects` 对象 + `currentProject` 字段。
**任务 ID 按项目自增**（每个项目从 T-001 起）。所有任务 API 默认作用于 `currentProject`。

```bash
# 列出项目 / 新建项目 / 切换项目
curl http://localhost:8788/api/projects
curl -X POST http://localhost:8788/api/projects -H 'content-type: application/json' \
  -d '{"id":"my-app","name":"我的应用","color":"#10b981"}'
curl -X POST http://localhost:8788/api/projects/my-app/activate   # 返回 followUps

# 复制任务到其它项目（原保留，目标项目生成新任务，状态重置 todo）
curl -X POST http://localhost:8788/api/tasks/T-002/copy-to/my-app
```

### 3. 同步方式：优先 curl 调 API

```bash
# 当前项目的任务
curl http://localhost:8788/api/tasks

# 新建（id 自动生成，不要传 id）
curl -X POST http://localhost:8788/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"任务标题","status":"doing","priority":"P1","notes":"备注","files":["a.js"]}'

# 部分更新
curl -X PATCH http://localhost:8788/api/tasks/T-001 \
  -H 'content-type: application/json' \
  -d '{"status":"done","notes":"已完成"}'

# 删除
curl -X DELETE http://localhost:8788/api/tasks/T-001
```

**API 不通时的回退**（说明 server.mjs 未启动）：直接读写 `tasks.json`（保证 JSON 合法 + v2 结构），改完跑 `node scripts/sync-taskboard.mjs` 同步 `tasks.md`。

### 3. 状态枚举（只用这四个）

| 值 | 含义 |
|---|---|
| `backlog` | 待处理 |
| `todo` | 准备做 |
| `doing` | 进行中 |
| `done` | 已完成 |

优先级只用 `P1` / `P2` / `P3`。

### 4. 不要做的事

- 不要手改 `tasks.md`
- 不要删除已有任务，除非用户明确要求
- 不要为新建任务手填 `id`（服务端自增）
- 不要编造不存在的关联文件

## 启动看板（如未运行）

```bash
node server.mjs            # 默认 8788，可用 PORT=9000 覆盖
```

浏览器打开 http://localhost:8788

## 结束前检查

- [ ] 当前任务在 `tasks.json` 中已 `done`
- [ ] 已记录改动文件
- [ ] API/同步未报错
