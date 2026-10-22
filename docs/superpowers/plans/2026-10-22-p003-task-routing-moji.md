# P003 R7 任务路由热配置与墨迹天气实施计划

> 执行：codex 使用 executing-plans 亲自编码；不委派代码。用户已授权两项分析完成后执行。

**Goal：** 修复自然实时问题漏建任务、天气缺城市和旧能力否认，提供灰度后台可编辑、预览、发布、回滚的路由规则及固定墨迹天气来源。

**Architecture：** Rust 单一路由权威＋候选专用版本存储＋后台异步拉取；沿用 SearchSession/SearchTasks 和现有语音播放合同。预览以同一 Rust 源码构建轻量 CLI，后台通过有界 stdin 调用，不复制第二套语言路由规则。

**Tech Stack：** Rust/Serde/Tokio，Node/Hono/SQLite，现有 Vue 单页后台，REA 6.7.0 网站证据。

**Spec：** [设计](../specs/2026-10-22-p003-task-routing-moji-design.md)、[REA 分析](../../../2-Projects/P003GameDemo20260513/docs/search-tools-20261021/MOJI_REA_ANALYSIS_20261022.md)。

**Global Constraints：** 沿用两个现有分支，不合 main；候选隔离；不改其他设备；不延窗；不自动开 P2；凭据/原始音频/真人正文不提交。测试失败保持新能力关闭，合成 RTC 与真人验收分开。

## 当前代码锚点

- Brain：`a39eb17513d0b4cf10fd5d76d92dcf3f202621b0`。
- Worker：`c0ea1e8e87b0e9416f7121023df68c16ca255254`。
- 这些是开发起点，非当前部署证明。发布前重新抓现役状态及新 R7 回滚点。

以下 server 为 Brain `2-Projects/P003GameDemo20260513/apps/server`，worker 为另一个工作树的 `2-Projects/realtime-voice-agent/rust-worker`。

## A. 先完成分析并固化接口

- [x] 使用指定 home-studio REA 访问官网、城市切换，读取动态能力，保留完整私有证据和脱敏报告。
- [x] 从 HK 只读验证北京/上海身份和天气数据，确认无登录、明确日期、响应体积与耗时。
- [x] 确定同步路由＋异步任务、固定天气源、版本/回滚及验收边界。
- [ ] 设计文档加入最终配置格式与预览 CLI 合同；代码前冻结首版支持范围。

## B. 纯路由与相同源码预览

文件：worker `src/search_routing.rs`、`src/search_policy.rs`、`src/search_policy_cases.rs`，`tools/search-route-preview/` 轻量构建入口及共用 fixtures。

- [ ] 测试先复现裸天气问题、城市追问、否定/引用/知识问题误触发、热更新影响旧待补参数、取消优先。
- [ ] 实现严格有界配置：schema=1、版本号/摘要、最多32条规则、每条最多32个触发/排除短语、匹配方式 prefix/contains_any/contains_all、action search/weather/chat；前缀显式搜索可提取主题。禁止任意正则/代码/URL。
- [ ] 保留既有内置控制、否定和拆句承接；配置只补充可编辑触发表达，不覆盖硬保护。天气缺城市返回专用澄清，下一句城市承接保留原日期。
- [ ] CLI 通过 stdin 接收有界 `{config, utterances:[{text,at_ms}]}`，输出逐项动作、原因、规则、查询和解析参数；无网络/任务提交。后台预览及发布回归使用该 CLI，同一源码确保一致。
- [ ] 先跑新增失败测试，再最小实现；既有304组合和取消/替换/续讲回归继续通过。

## C. 候选专用版本存储与 Worker 热加载

文件：server `src/tools/search-routing-config.ts`、`src/tools/search-routing-store.ts`、`src/routes/search-routing-admin.ts`、`src/tools/search-runtime.ts`、`src/routes/search-tasks.ts`、`src/tools/search-tasks.ts`；worker `src/search_tasks.rs`。

- [ ] 新增候选 `search-routing.db`，草稿/不可变版本/完整SN发布/加载确认分表；事务及 expected_revision 防并发覆盖。
- [ ] 管理路由复用 admin 身份；发布目标必须属于当前已准备灰度名单，不能写 enabled/tools/deadline。403、非法字段、并发409和失败不改有效版本均测试。
- [ ] 增加认证后的 `/internal/search-tasks/routing` 与加载确认接口；范围和窗口校验继承候选 guard，禁止未命中 SN 读取/加载。
- [ ] Worker 独立后台任务每5秒刷新，通过有界事件队列/内存快照同步给路由，不能在语音主循环 await。拉取异常保留上个有效版本，无初始配置用保守内置规则。
- [ ] 真正应用快照后回报版本与时间；后台区分候选库已发布/Worker已加载，任务账本记录Brain实际使用版本，不把 HTTP 已发送当加载成功。
- [ ] submit 固化路由版本/规则与来源配置；旧版本的在途任务不因发布改变来源，取消仍按 task ID。旧协议无版本继续兼容默认来源。

## D. 墨迹固定天气适配器与候选能力一致性

文件：server `src/tools/moji-weather.ts`、`src/tools/search-runtime.ts`、`src/tools/search-chat-policy.ts`、`src/routes/custom-llm.ts`；测试 `scripts/moji-weather.test.ts` 与 search-chat-policy 测试。

- [ ] 先写失败测试：城市不符、缺/过期更新时间、今天明天跨午夜、错误日期、超限/重定向/429/超时、取消、缓存隔离和热配置固化。
- [ ] 固定端点、白名单城市、身份回读；总6秒/单次3秒/128KiB；当前2小时、日预报24小时；缓存5分钟＋单飞＋错误冷却。
- [ ] 当前/今明后天/当前AQI短模板，保留来源、城市、观测/更新/目标日期；不让 LLM 编造数值。未验证城市/范围不伪装支持。
- [ ] 候选人格去除冲突的“长大才会查”能力否认，保留人格/安全其余部分；普通对话过滤器无任务承诺。非候选提示完全不变。

## E. 灰度后台

文件：`apps/web/public/admin/index.html`、`server/src/search-canary-status.ts` 与相应浏览器测试。

- [ ] 增加规则列表及触发/排除表达编辑、天气源开关、草稿保存、话术预览、完整SN选择发布、历史版本回滚。
- [ ] 显示版本、应用确认时间、离线待加载、保存失败/并发冲突；请求失败不显示旧成功；退出/换身份阻断旧请求回填。
- [ ] 预览不建任务；重复点击不会重复发布。管理接口和按钮权限同时校验。浏览器测试至少覆盖编辑→预览→发布→回滚及窄屏/失败态。

## F. 验证、候选部署及交付

- [ ] Brain 搜索全套/设备认证/隔离/首句派单回归，Rust 全测，Linux release及轻量预览CLI构建，记录源码与完整产物SHA。
- [ ] 新鲜采集现役/候选状态及资源；建立 R7 回滚记录，候选空闲时替换。后台服务只发布所需文件，逐项记录。
- [ ] 先默认关闭新天气来源；验证隔离、非目标不变、回滚、到期守卫；当前授权窗口未过期才为原有目标范围发布有效配置，不新延窗。
- [ ] 合成 RTC 覆盖自然天气、天气追问、科普/新闻/开放时间、搜索中聊天、空闲补播、插话/续讲、取消/改查；保留任务完成、音频非静音、字幕和metrics证据。冷却间隔≥30秒，不抢真实活跃会话。
- [ ] 真机仍待持有人确认，输出新测试用例及技术验收记录；Air Downloads 传输后核 SHA。两分支 commit+push 并核远端SHA，不把未过项目写成通过。

署名：codex（OpenAI）| 2026-10-22
