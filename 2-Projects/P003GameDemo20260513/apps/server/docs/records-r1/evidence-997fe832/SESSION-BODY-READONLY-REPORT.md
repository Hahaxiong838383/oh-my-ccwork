# 给主13：P003 工作树会话正文只读排查

**结论：未完全解决用户界面空白；已证实三条真实会话正文完整可读，现役 HTTP 前端的侧栏投影、正文状态/适配器、正确 provider 深链均通过。未获得用户浏览器实态，不能将持续空白归咎缓存，也没有证据支持再次打静态补丁或升级。主开发和主13直接交付回执无需等待本问题。**

取证时间：2026-11-16 19:53:32 +0800。遵守本轮只读范围：仅调用读取 API、读取 Git/部署资源；只在本证据目录写文件。未改源码/静态文件/数据库/会话，未发消息占位、未取消/恢复任务，未建立 ACP 原生会话连接。CODEG_TOKEN 只在进程内从环境读取用于请求头，未输出、未放入 URL/argv/报告。

## 真实会话先验

三条均为 folder_id=57、parent_id=13、kind=delegate、status=pending_review。

|会话|实际标题|agent|native external_id|正文轮数|可适配 text / tool-call / reasoning|
|---|---|---|---|---:|---|
|352|P003 小程序真实数据R1｜服务端开发与自检|codex|01a1e3ea-c2b0-76c2-8b5c-fb83d84ec1d1|137|14 / 82 / 57|
|350|P003 小程序真实数据R1｜服务端合同与开发接续|codex|01a1e3d7-c985-7f32-acf3-8f8a5366db8b|54|9 / 33 / 20|
|356|P003 Miniapp Real Data R1 Independent Review|grok|01a1e40a-62c3-7f20-b6fa-e5e351c3ec19|2|7 / 61 / 24|

已实际读取首条任务、过程和末条回执。352 包含开发实现回执，350 包含合同核查回执，356 包含独立评审结论；Grok 把多次工具/文本集中到一条 assistant turn，因此“2轮”不等于没执行。上述回执是历史正文，不能替代主13正在交付的最新业务状态。

list_all_conversations 的 message_count 三者均为0，而 get_folder_conversation 的实际正文分别137/54/2；这是接口计数口径差异，不能据列表计数判定正文丢失。前端适配器已读到真实 text 内容，不是思考块充当结果。

folder57 真实路径 `/Users/fu-121/.codex/worktrees/p003-mini008-realdata-20261111`，alias 为 `P003 小程序真实数据R1｜开发与联调`，folder.parent_id=12（这是文件夹父关系，区别于 conversation.parent_id=13）。Git worktree list 确认分支 `codex/p003-mini008-realdata-20261111`，取证时 HEAD `a4a9ec823e83ad976c968ab3fd83de3d7034eaaf`。未改变分支/工作树。

## 实际入口、列表、点击与正文证据

1. HTTP `/workspace` 与 `/workspace.html` 内容相同，SHA256 `016eabd4974568c1c342e839bbd3276db62e8d7a99733415a95c940123879c2b`；入口引用 `048tzznh3mzxz-wt-5c9cd45fc1ee.js`。读取入口所有 script 资源（去重50个），均与指定 releases/current/web 本地资源一致。根路由 `/` 是不同入口；本报告深链使用 `/workspace`。
2. 重跑旧证据的**实际 HTTP API wrapper → workspace store → sidebar grouping/flatten**脚本：旧备份模块使 folder57 为空；现役模块产生356/352/350三条侧栏会话行。该测试不是 list API 存在性断言。边界：重放采用无标签筛选、展开文件夹的输入，不能代表用户 localStorage 中的筛选/折叠状态。
3. 现役 sidebar 单击回调 `ny((id,agent,folder)=>openTab(folder,id,agent,false))`，双击只改变 pin。Tab 继续传递 conversationId 和 agentType；正文使用统一 renderer，不把 Grok 转成 Codex。未见针对这些 delegate 的正文过滤分支。
4. 执行现役 module209165 API wrapper、module820271 detail store/reducer/selector、module489362 turn adapter及其实际工具依赖，GET等效读取采用 POST `get_folder_conversation`，参数 `{conversationId,tailTurns:120}`。三个会话均 detailError=null、非空 render rows，适配后有真实 text/tool-call/reasoning。当前响应仍返回137/54/2轮，不能机械把tailTurns当返回数量。只隔离传输及 Zustand 状态基础，不启动 React DOM/ACP。
5. 执行现役 DeepLinkBootstrap 的真实 gate，三个正确 provider 链接均进入预期 openTab 参数。负例356配agent=codex会被拒绝并提示 `Linked conversation not found`；因此356入口必须是grok。这里只捕获模拟 openTab 调用，没有写实际 tabs/session。
6. 只读 list_opened_tabs 的当前共享持久态中，相关筛选仅见主13（folder12、codex、active）；未见350/352/356。它不能证明用户没有点击过，也不能代替浏览器当前内存状态。

## 可用真实会话入口

以下是当前服务的有效数据与路由入口，**视觉未验**。127.0.0.1只指向运行Codeg的这台机器；若用户经远程域名访问，保留原访问origin，仅使用相同路径和参数。

- 开发352：`/workspace?folderId=57&conversationId=352&agent=codex`
- 合同350：`/workspace?folderId=57&conversationId=350&agent=codex`
- Grok评审356：`/workspace?folderId=57&conversationId=356&agent=grok`

## 最小可证根因与后续建议

- **已证实的原缺陷**：旧 store 不加载/过滤跨文件夹 delegate，旧模块能够复现空目录；本次回读的现役模块已放行。这解释原问题，尚不能解释用户当前仍空白。
- **持续空白根因未定**：CUA 返回 apps=[]、browsers=[]，无法观察用户页面、真实点击、Console、Service Worker命中及内存状态。未将旧缓存、用户筛选、错误provider或运行态抑制当成已证实根因。
- 当前最小行动是给上方真实入口/主13真实回执；**不建议再改数据库、会话父子关系，或重打静态补丁/大升级**。本轮无需阻塞主开发。
- 如仍需闭环，仅由用户浏览器补四项脱敏证据即可：当前origin/path；实际加载store脚本URL（应含`-wt-5c9cd45fc1ee`）；点击352时`get_folder_conversation`的conversationId、HTTP状态和turns数量；首条Console错误以及是否有标签筛选。不要共享Authorization、token、完整HAR或整段私有正文。若是侧栏空白而不是正文空白，再取`list_all_conversations`请求的includeChildren值和是否包含352。
- 只有确认实际加载旧store，才建议正常重载以获取新版本并复验；只有拿到异常请求/运行时错误，才对具体断点做最小修复。当前无缓存归因证据。

## 证据索引与复跑

- `SESSION-SUMMARIES.json`：标题、状态、归属、native ID、正文哈希。
- `session*-private.json` / `session*-tail-private.json`：真实正文，仅私有目录保存，不提交git。
- `HTTP-ENTRY-ASSETS.json` / `http-assets/`：入口、HTTP/磁盘SHA及资源副本。
- `LIVE-SIDEBAR-HTTP.json`：旧模块空目录 vs 现役三会话进入实际侧栏投影。
- `BODY-RENDER-VERIFIED.json` / `BODY-ADAPTER-VERIFIED.json`：正文store/selector/adapter真实执行结果。
- `ROUTING-VERIFIED.json`：正确/错误provider深链gate及无可控浏览器事实。
- `verify-body.cjs`、`verify-adapter.cjs`、`verify-routing.cjs`：仅用环境token，网络命令白名单只读；路由测试openTab为mock。适配器扩展测试最初因测试加载器漏IIFE资源而失败，补齐实际资源注册后通过，非产品错误；最终成功日志为`adapter-test.log`。
- 重跑侧栏脚本需指定`CODEG_PORT=3080`、`CODEG_VISIBILITY_EVIDENCE_DIR`为本目录、`CODEG_VISIBILITY_BACKUP_DIR`为前次证据目录，避免输出到旧目录。

署名：codex（OpenAI）| 2026-11-16 19:53:32 +0800
