# 本地任务看板

更新时间：2026-06-22T04:39:03.192Z
当前项目：**local-board**

## local-board `local-board` ← 当前

### Backlog (1)

- **T-002** 接入 Claude Code Skill 自动维护任务 · P1
  - SKILL.md 已创建并以 curl 调 API 为主，含项目维度说明；本次会话已按 Skill 规则验证可用
  - 文件：.claude/skills/task-board/SKILL.md

### Todo (1)

- **T-005** 任务卡片显示关联文件与最近改动摘要 · P3
  - 第三版：显示最近一次改动摘要、是否已 commit、是否有 diff
  - 文件：index.html

### Doing (2)

- **T-001** 初始化本地任务看板 · P1
  - 创建本地看板页面和任务数据结构
  - 文件：index.html, tasks.json, tasks.md
- **T-004** 增加项目维度过滤与文件关联 · P2
  - v3 已实现：多项目结构 + 项目下拉切换 + 复制跟进弹窗，单文件 tasks.json 含 projects
  - 文件：index.html, server.mjs, scripts/lib.mjs

### Done (3)

- **T-003** 配置 Stop Hook 自动同步 tasks.md · P1
  - 每轮结束时自动校验 tasks.json 并生成 tasks.md
  - 文件：.claude/settings.json, scripts/sync-taskboard.mjs
- **T-006** 看板顶部加统计数据栏 · P2
  - 已实现：顶部统计栏显示 Backlog/Todo/Doing/Done 各状态数量、总计、完成百分比进度条。renderBoard 内实时刷新
  - 文件：index.html
- **T-007** 看板页面新增深色模式切换按钮 · P2
  - 新增 themeBtn 深色模式切换按钮，新增 [data-theme=dark] CSS 变量覆盖，localStorage 持久化主题，浏览器验证浅/深色切换与刷新保留均正常
  - 文件：index.html

