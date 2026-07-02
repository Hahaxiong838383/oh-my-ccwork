# 本地任务看板 (task-board)

个人 AI 开发驾驶舱：纯本地的任务看板，**人在页面上能直接增/删/改/拖拽**，
同时 Claude Code 通过 Skill + Hook 自动维护——双方都写同一个 `tasks.json`。
不依赖数据库、不依赖登录、零第三方依赖。

## 结构

```txt
task-board/
├─ index.html              # 交互式看板页面（拖拽 + 按钮 + 全字段编辑）
├─ server.mjs              # 零依赖 HTTP 服务：REST API + 静态托管
├─ tasks.json              # 唯一数据源（页面 & Claude Code 共同读写）
├─ tasks.md                # 派生的人类可读清单（脚本生成，勿手改）
├─ scripts/
│  ├─ lib.mjs              # 共享核心：读写 / 校验 / 生成 md
│  └─ sync-taskboard.mjs   # 命令行：校验 + 同步（薄壳，调用 lib）
├─ .claude/
│  ├─ skills/task-board/SKILL.md   # 告诉 Claude 何时 / 如何更新看板
│  ├─ commands/
│  │  ├─ task-add.md
│  │  ├─ task-done.md
│  │  └─ task-sync.md
│  └─ settings.json        # Stop Hook，每轮结束自动同步
└─ README.md
```

## 运行看板

```bash
cd task-board
node server.mjs            # 默认端口 8788，可用 PORT=9000 覆盖
```

浏览器打开 **http://localhost:8788**

交互：
- 右上角 **+ 新增任务** 打开表单，可填全部字段
- 卡片悬停显示 **← → 编辑 删除** 按钮
- 卡片可**拖拽**到任意列改状态
- 页面每 3 秒轮询；你正在拖拽/编辑时自动暂停，避免打断输入
- `Esc` 关闭弹窗，`Cmd/Ctrl+Enter` 保存

## 工作链路（双向同步）

人在页面操作：
```txt
点 + 新增 / 拖拽 / 编辑 / 删除
  ↓
fetch /api/tasks
  ↓
server.mjs 重读磁盘最新 tasks.json → 合并 → 原子写 → 生成 tasks.md
  ↓
页面刷新 + 看板更新
```

Claude Code 操作：
```txt
你说："帮我实现登录页"
  ↓
Skill 触发：改 tasks.json，状态 = doing
  ↓
Claude Code 写代码
  ↓
完成：状态 = done，Stop Hook 跑 sync-taskboard.mjs
  ↓
页面 3 秒内自动刷新看到新状态
```

两边写的是同一个 `tasks.json`，server 每次写操作都会**重读磁盘**拿到对方最新改动，不覆盖。

## 数据结构（v2，多项目）

`tasks.json`：

```jsonc
{
  "version": 2,
  "currentProject": "local-board",
  "projects": {
    "local-board": { "name": "看板本体", "color": "#6366f1", "tasks": [...] },
    "my-app":      { "name": "我的应用", "color": "#10b981", "tasks": [...] }
  }
}
```

- 任务 ID **按项目自增**（每项目从 `T-001` 起）
- 任务状态只有四种：`backlog` / `todo` / `doing` / `done`
- 字段：`id`、`title`、`status`、`priority`(P1/P2/P3)、`project`、`files`、`notes`
- 读取旧版（v1）数据时**自动迁移**，不丢数据

## 多项目与复制跟进

- 顶部下拉切换项目；切换时若当前项目有 `doing` 任务，会弹窗问是否复制到新项目跟进
- 复制语义：**原任务保留**，目标项目生成新任务（新 id、状态重置 `todo`、notes 注明 `跟进自 xxx`）
- 单卡片暂不提供「复制到…」按钮，统一走切换时的弹窗（如需可后补）

## 注意

- `tasks.json` 是唯一数据源；`tasks.md` 与看板展示都由它派生，不要手改 `tasks.md`。
- 必须用 `node server.mjs` 启动（**不能**用 `python3 -m http.server`，它只能读不能写，页面按钮会没反应）。
- `.claude/settings.json` 的 Hook 命令以本目录为工作目录——把 `task-board/` 作为 Claude Code 项目根目录打开即可。
- 同步脚本与服务都自我定位（基于 `import.meta.url`），从任意 cwd 调用都能找到数据文件。

## REST API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/tasks` | 返回 `{ updatedAt, tasks[] }` |
| POST | `/api/tasks` | 新建任务（body 为字段，id 自动生成） |
| PATCH | `/api/tasks/:id` | 部分更新（合并写回） |
| DELETE | `/api/tasks/:id` | 删除任务 |
