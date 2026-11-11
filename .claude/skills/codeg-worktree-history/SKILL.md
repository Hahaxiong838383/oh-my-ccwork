---
name: codeg-worktree-history
description: 用户希望在 Codeg 前端看到外部创建的 Git 分支或工作树、工作树显示暂无会话、需要保留原会话并在新工作树继续历史时使用。
---

# Codeg 工作树与历史会话

Git 工作树、Codeg 文件夹、原生智能体会话是三个独立对象。登记目录不会自动把旧历史归到新目录。

## 操作顺序

1. `git worktree list --porcelain` 核对真实路径、分支和 HEAD；只读检查共享主仓，禁止为显示分支而切换或重置主仓。
2. 定位当前 Codeg 实例、数据目录和服务端口。先查已安装 MCP、CLI 和部署文件；搜索限定项目及资源目录，别递归扫描整个用户目录。读取当前前端接口定义，不能把下表当所有版本的固定 API。
3. 认证先按 secrets-vault-ops；当前 Codeg 子进程若已带有效 `CODEG_TOKEN`，可在进程内读取直接发请求。不得打印 token、放入 argv/URL/文档；不要无谓绕去读取 root Keychain。
4. 用 `list_all_folder_details` 查是否已登记，再 `open_worktree_folder` 关联正确源文件夹；用 `update_folder_alias` 设置易辨名称，`open_folder_in_workspace` 通知前端。已存在就复用，避免重复入口。
5. 先定位任务已有的真实会话和 agent/native session ID，优先复用。用户需要复制历史时才进入 fork 流程；先核该 agent 是否支持 fork，不支持时禁止伪造原生历史。保留原会话；不要直接 UPDATE Codeg SQLite，不伪造消息，也不要在正在运行的原连接上原地 fork/移动。
6. 对 Codex，可使用同一安装版本 app-server 的 `thread/read` 找最后完成轮次，再 `thread/fork` 指定原 threadId、目标 cwd、lastTurnId。Fork 后 `thread/name/set` 标明历史快照。只复制历史，不调用 `turn/start` 或替用户发 prompt。
7. 用 Codeg `import_selected_sessions` 导入新 ID；回读 folder_id、git_branch、external_id、turns_total，核对原会话归属/ID保留、快照边界正确。不同 API 的 message_count 口径可能不同，不能据计数差就断言丢历史。
8. 核对当前前端实际查询、最终列表过滤及事件更新，并打开真实正文；不能只查包含子会话的 API 就说左侧可见。给用户实际 session 链接和工作树路径。复制的历史须标明快照截止且不实时同步；无可控浏览器时明确仅完成接口/列表逻辑/正文验证，页面刷新后的视觉确认仍待核。

## 工作树必须带可见会话（用户明确规则）

- 分配到工作树的任务，交付必须包括左侧可见的对应会话，以及可打开的真实任务、进度和结果正文；只登记目录、分支或发 session 链接不够。
- 查前端实际使用的查询参数与最终 selector/upsert。`includeChildren:true` 查到委派子会话，仅证明数据存在；`parent_id`、`kind=delegate/loop` 仍可能被前端过滤。前端已显式包含子会话时也要核后续过滤，不能机械套旧参数。
- 复用既有真实会话；不取消/搬迁运行中的会话，不发送空消息占位，不为显示另开重复执行任务。`message_count=0` 不能替代 native `turns_total` 和正文检查。
- 修改显示应限定实际问题：独立工作树内的跨文件夹委派可见，同目录子任务仍嵌套；保留 parent/native ID、删除保护及原会话正文。
- 前端修复须有原文件 SHA、可回滚原件、实际列表模块回归及 HTTP 回读；版本升级后重新核验，不能盲套旧压缩文件补丁。无浏览器时如实标注视觉未验。
- 静态文件已更新与当前浏览器已加载新版是两项验证。原 URL 原地换 JS 时，运行中的页面仍可能用旧模块；需核 HTML 引用、真实 API wrapper→store→侧栏行投影、当前页面版本/强制刷新后的视觉结果。仅单测或 HTTP SHA 正确不能宣称画面已修复，也不能未取证就认定缓存。
- 发布 hashed 静态资源前先核 Service Worker：cache-first 会永远复用同 URL。热修复须使用新内容版本 URL并同步 HTML/Flight 全部引用，保留旧资源给已打开页面；用实际 SW 加预置旧缓存复现与验证，禁止只在原 hashed 文件上换内容。普通重载仍是当前页获取新代码的必要边界，不强制重启其它会话。
- 已完成的历史快照必须标截止，不冒充实时同步；不同 agent 不支持 fork 时不能套用 Codex 的 fork 接口。

根因、复验和回滚例见 [委派会话可见性](references/delegated-worktree-visibility.md)。

## 版本核对过的接口样例

2026-10-21 的 Codeg 公司 Studio 0.34.0 前端资源使用 `POST /api/<command>`、JSON body、Authorization Bearer。**folder ID 与 conversation ID 属于不同命名空间**，都必须现查，不硬编码旧数字。

| 命令 | 参数 |
|---|---|
| list_all_folder_details / list_open_folder_details | `{}` |
| open_worktree_folder | `{path, sourceFolderId}` |
| update_folder_alias | `{folderId, alias}` |
| open_folder_in_workspace | `{path}` |
| list_all_conversations | `{folderIds:[...], includeChildren:false}` |
| import_selected_sessions | `{selections:[{agentType:"codex", externalId:newThreadId}]}` |
| update_conversation_title | `{conversationId, title}` |
| get_folder_conversation | `{conversationId, tailTurns:1}`；计数读取 `turns_total` |

Codex fork 参数（先核本地版本）：`{threadId:sourceId,cwd:targetWorktree,lastTurnId:lastCompletedId,excludeTurns:true}`。`excludeTurns` 是省略响应中的历史，不是删除快照历史；之后用 thread/read 和 Codeg 回读验证。app-server initialize 后发 initialized；辅助进程退出前不启动模型轮次，正常终止只属于自己的辅助进程。

## 失败与恢复

- 只看见目录、没有会话：查文件夹下的会话列表，不重复建 Git 分支。
- 当前会话忙：不要 cancel 原会话来迁移历史；选完成边界创建独立快照，无法安全复制时保留原会话链接并说明限制。
- 导入失败：记录已 fork 的 native ID，重试导入同一 ID，避免每次重造副本。
- 活跃源会话有新消息：快照截止边界保持不变，不能声称覆盖后续消息；需要更新快照时重新编号，不覆盖原件。
- 用户已经把启动 prompt 发到新会话：旧会话只做其当前授权的归档，不再重复开发部署。复盘若需要独立 Git 写入，用单独文档分支；不写正在开发的工作树。
- 保留本次新增文件夹/会话 ID、源 ID、完成边界、归属前后回读与 Git SHA 作为回滚依据；只撤自己新建入口，不删除原历史或回灌整库。

## 完成判据

工作树存在且分支正确、Codeg 登记正确、真实会话进入当前前端列表投影且正文含任务/进度/结果、原会话关系保留、用户知道入口与历史边界。可控浏览器可用时实际打开核验；不可用时明确视觉未验及刷新加载要求，不把 API 可查冒充页面验收。业务测试、生产部署、设备开窗是另一项验收，不能随前端关联一起宣布完成。
