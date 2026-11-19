# 修正缓存发布遗漏

结论：首轮原地修改 hashed chunk 的发布方式违反了当前 Service Worker 的缓存约定。本轮已用新的内容版本地址发布两份修复脚本，并同步八份 HTML/Flight 路由引用。尚未取得用户刷新后的真实画面，不能宣布视觉验收通过。

## 证据

Grok 255 的只读复核指出现役 `sw.js` 对 `/_next/static/` 使用 cache-first，将这些 URL 视为不可变；当前注册版本相同且文件名未变时，命中的旧缓存不会请求服务器。主13已独立读取并运行这份实际 SW：预存首轮修复前的脚本，同 URL 确实返回旧字节；改用新 URL 后获取修复字节并正确复用新缓存。该机制能复现用户截图，但用户浏览器具体缓存内容未直接读取。

此外已实测真实 HTTP API wrapper→store→实际分组/侧栏行函数：旧版只显示 253/254、44/53 为空；部署版显示 253、182–191、254、251。snake_case wrapper 参数确实转为服务器接受的 camelCase，不改接口合同。

## 发布范围

- 新建 `048tzznh3mzxz-wt-5c9cd45fc1ee.js`、`3mp80sn446_ra-wt-437913cd27fd.js`，内容与首轮修复后的两份脚本完全相同。
- 只更新 workspace/commit 的 HTML、txt 和各两个 Flight 分片，共八个文件中的资源名。全资源扫描确认旧名没有其它运行引用需要同步。
- 保留旧资源供已打开的页面使用；没有修改 SW 缓存策略、清空用户缓存、重启服务/agent、改数据库或伪造会话。
- 管理/搜索面板仍按原逻辑查询根会话，它们不是本次截图侧栏的原因；没有把“查到所有子会话”无条件扩散到批量管理功能。

## 验证与回滚

`CACHE-PUBLICATION-MANIFEST.json` 记录 2 新文件及 8 路由文件的 before/after SHA。原件与候选仅保存在 `/Users/fu-121/.local/state/codeg-worktree-visibility-20261111/cache-publication-v2`。

`SW-CACHE-TEST.json`：旧缓存场景复现、新资源缓存穿透与再利用、8 份引用、API/WebSocket 不拦截均通过。`LIVE-SIDEBAR-HTTP.json` 的 assetUrls 已证明线上 workspace 引用新地址，最终侧栏行不再为空；该测试仍不等于真实浏览器视觉验收。

发布脚本只允许已核 before SHA，并先创建新资源再更换引用。回滚工具默认只核验，`--apply` 才操作；先还原路由引用，再删本次新建资源，任何漂移都拒绝。它不是多文件事务，中断按已恢复输出续核，禁止整库回灌。若要进一步回退首轮逻辑，再用首轮 rollback_assets.py。当前没有执行线上回滚。

运行发布/缓存测试脚本时，应放在上述私有父目录（读取首轮原件）；仓库保存的是可审脚本和非敏感证据，不包含完整编译包。

署名：codex（OpenAI）| 2026-11-11
