# 独立工作树的委派会话不可见：2026-11-11

现场：P003 自然话术词库工作树 folder 53，真实 Grok 会话 251，parent 13，kind=delegate。任务与结果均在原生正文中，但左侧显示“暂无会话”。

## 根因与验收漏项

0.34.0 当前部署的 workspace store 默认 listAllConversations() 不取子会话，事件 upsert 又直接忽略 parent_id 非空的记录。仅用 includeChildren:true 查询能找到 251，不等于真实侧栏会显示。原生正文有两轮，不能拿摘要 message_count 判断历史丢失。

先核原生能力：导入同 ID 会跳过；Grok 不支持 fork；当前接口没有将 child 提升为顶层的命令。保留真实记录，只改当前前端显示条件：显式获取子会话，允许 folder 有 parent 且会话父子 folder 不同的 delegate 进入列表。同目录 child、loop、未知父关系继续隐藏，保留 tombstone。

## 已做验证及边界

- 原编译 workspace store 的首次加载断言失败，修复两个现役 bundle 后各 9 项、共 18 项通过；测试直接装载实际模块，只隔离传输/状态依赖。
- 用真实 API 快照重放两个实际模块，251 与 13 均进入列表；正文回读确认任务和结果，原 external_id/parent_id 保留。
- 原件/候选/线上文件/HTTP 逐一 SHA 校验。没有数据库写入、agent 重启或 P003 生产变更。
- CUA 没有可用浏览器，未做视觉验收；刷新页面加载修复后仍需核真实画面，不能宣称已经看见用户屏幕。
- 这是部署资源的临时修复，后续 Codeg 升级可能覆盖；需在对应源码同步相同判定后常规构建，当前不声称源码已合并。

## 证据与回滚

私有原件与完整记录：`/Users/fu-121/.local/state/codeg-worktree-visibility-20261111`。
仓库归档：`docs/codeg-worktree-history-20261111/`（修复脚本、实际模块回归、哈希清单、公开验证与回滚说明）。不提交私有会话全文、全部会话列表或完整共享记忆。

回滚只恢复 manifest 中两个文件：确认当前 SHA 仍为本次 after，才原子恢复对应 before；有漂移就停止，禁止盲盖他人新版本。不回灌数据库、不删会话。恢复后 HTTP SHA 核同，刷新前端。备份只对当前固定版本有效，不能套到升级后的 release。

署名：codex（OpenAI）| 2026-11-11
