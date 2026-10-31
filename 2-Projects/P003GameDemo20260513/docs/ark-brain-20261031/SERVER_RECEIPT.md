# 方舟数据与小可大脑：服务端候选回执

**结论：服务端候选已实现，隔离验收通过，可交总调度会话13复核与安排预发；尚未部署、尚未接入安卓真实快照，不能宣称02000026已可回答实时进度。**17:11调查基线中该SN Analytics为0条，尚无本轮真实快照到账证据，本轮没有开启上传或造生产事件。

代码分支：`codex/p003-ark-brain-context-20261031`，工作树 `/Users/fu-121/.codex/worktrees/p003-ark-brain-context-20261031`。Codeg folder30/session45。现役固化 `0708d768`，计划修订 `83cff28c`；静态纠偏 `e6f330ec`；主实现代码锚 `0e1f2cd4e7a900d8e2ab5b8736ddc0c3c5af5529`（含版本化合同示例）。实现均由Codex亲写；只读辅助评审不代写代码。

## 已实现及实际效果

| 层 | 行为及边界 |
|---|---|
| 静态知识 | 资源用途、双钱包歧义与当前G1奖励分开说明；有效专注不套夜航、离线或旧五段阈值；缺数据不填0；可领不等于到账，小可不代领 |
| 历史埋点 | Analytics内部鉴权摘要按完整HMAC device_key读取原事件after/quantity；不读rollup、不传原始properties/正文，不给Brain HMAC secret；14天收件范围、最多512条，正事实发生时间也在14天内且发生/收到均不早于授权水位；水位前数据仅用于GM否决，超限未知 |
| 身份与授权 | 当前注册active+独立device Brain账号；Analytics还会只读ark.db复核真实门控及授权水位，拒绝内部caller向前扩大水位；epoch覆盖换绑ABA/删除重建/状态/parent归属/撤销变化；授权建立未来watermark，旧归属unknown；任何设置重写会清当前授权/快照重新授权 |
| GM/时钟 | 显式正常日标记且早于事实、时间可信才进入历史；已知GM日排除，来源不明不称真人成绩；时钟/截断/冲突/未知item不猜 |
| 实时快照 | 严格v1白名单、16KiB、每SN每分钟12请求；Device Bearer主体、撤销检查、boot/seq重放保护；只存当前一行；当前重复不续期，已覆盖旧seq stale |
| 对话接线 | 正常设备状态意图及连续短追问才读；指定Worker进程账号+role=device+严格room+当前授权；parent/匿名/override/feedback不读；回调key与AUTH secret必须实际配置，不能借开发fallback开能力 |
| 解释 | captured/received双30秒建议窗口、normal及当前CST日才能报告下一奖励进度；家族币/宝箱/补勤卡、暂停/停止/未知/可领/已领/日完成分开；仅引用端侧remaining_seconds，不按墙钟递减 |
| 记忆 | 动态审计仍落conversation且持久标memory_excluded，闲时窗口也携带标记；动态当前轮不抽画像/onboarding，后续history剔除旧数值；extractAndPersist入口覆盖idle窗口，阻止画像与memory-item污染；纯正常兴趣仍可抽取 |
| 管理验收 | 只有现有admin权限的settings/preview API，事实格式化与custom-llm同源；**没有新增后台tab/UI**，API不冒充已上线界面 |

## API与配置（候选，公网尚未核路由）

- Device：`POST /v1/device/ark/state`，现有Device Bearer；body合同见 [ANDROID_HANDOFF.md](ANDROID_HANDOFF.md)。不改变 `/v1/device/analytics/events:batch` 夜批协议。
- Admin：`GET/PUT /v1/device/ark/admin/settings`，`GET /v1/device/ark/admin/preview?sn=<目标SN>`，现有后台admin Bearer。guest/editor/Device Bearer均不能授权；网关需由总调度核可达并保持admin鉴权。GET settings附当前授权水位，PUT enabled会**立即持久生效**，不是draft。
- Analytics内部：`POST /internal/analytics/ark-summary`，既有 `X-Analytics-Internal-Token`；仅loopback服务间，不暴露公网。请求subject/account_id/epoch/not_before_ms由Brain服务生成，Analytics只读同一ark.db复核enabled、当前grant与水位，拒绝调用者向前扩大历史读取；不得给客户端发内部secret。

| 配置 | 默认/用途 |
|---|---|
| ark.db设置enabled | 默认false；新库默认无授权设备 |
| ARK_DB_PATH | Brain默认 ./data/ark.db；Analytics默认在devices.db同目录找ark.db；发布须为两进程显式指定**同一绝对路径**并核实际进程可读/0600，避免默认路径分歧 |
| ARK_CONTEXT_SN_ALLOW | 默认仅BJP00326081002000026，是管理员可选范围上限，不自动授权；最多32项 |
| ARK_WORKER_ACCOUNT_ID | 显式指定现有受信Worker进程账号；未指定时兼容SEARCH_WORKER_ACCOUNT_ID；两者均无则不注入 |
| AUTH_JWT_SECRET / CUSTOM_LLM_API_KEY | 复用现有真实鉴权；未配置不会给对话读取新数据；不改既有匿名聊天行为 |
| ARK_ANALYTICS_INTERNAL_URL | 默认 http://127.0.0.1:3006；只向127.0.0.1 HTTP请求，禁止重定向/外网；无效或缺secret降级历史未知，不影响合法当前快照 |
| ANALYTICS_INTERNAL_SECRET | 复用既有内部密钥，不写Git/文档、不复制HMAC secret |

settings示例：`{"enabled":true,"subjects":["BJP00326081002000026"]}`。只由总调度在发布并核身份后设置。本开发会话没有执行。重复PUT不是保活，会重置授权水位并清快照；换绑/禁用后恢复需要重新核身份授权。开方舟门不等于开Analytics上传，两者独立。

## 证据与复验

详见 [TEST_RESULTS.json](TEST_RESULTS.json)。在 `apps/server` 下：

```sh
node --version
npm run test:ark
npm run test:analytics
node --experimental-sqlite --import tsx scripts/device-brain.test.ts
node --experimental-sqlite --import tsx scripts/xiaoke-kb.test.ts
node --experimental-sqlite --import tsx scripts/memory-extract.test.ts
node --experimental-sqlite --import tsx scripts/listening-rtc-brain.test.ts
./node_modules/.bin/tsc --noEmit
```

- 方舟专项：知识3、状态13、历史9、runtime7、真实本机HTTP/SSE7，共39项。HTTP/SSE测试同时启动临时Brain/Analytics/mock模型服务；网络仅允许127.0.0.1，所有身份和数值合成，独立临时数据库。
- 真实SSE证据验证发给上游的prompt、截至时间、余额0与unknown区分、追问重新查询、旧999999数值剔除、admin预览同源、缺回调key/parent无读取。模型输出用本机mock，**不代表外部LLM的自然语言质量已验**。
- 真实conversation审计保留；动态当轮、后续混合窗口、真实scheduler.flushIdle路径不发记忆模型请求、不写game_progress/memory-item；正常“我喜欢画画”仍经mock抽取落画像；另验仅剩“三枚呀”的元数据标记窗口不触发idle抽取。
- 现有Device Brain 29项、KB6项、记忆抽取15项、scheduler17项和Analytics十个脚本通过；倾听RTC Brain隔离预检通过。
- 全量类型检查**未通过**：12条倾听/天气诊断与83cff28c临时副本逐字一致，本功能无新增类型诊断。搜索补充检查同样存在基线问题：R22 3/14失败；dialogue脚本引用缺失的searchDialogueHistory导出无法启动。已在未修改基线重新运行证实，未修改这些功能，不隐瞒、不擅自修并行会话的实现。

只读初审没有Critical，指出的3项Important（水位、GM负证据、跨来源冲突）均由主实现修复并红绿复验；窄范围只读复核确认3项关闭。评审代理未跑测试，自动化结果由Codex本人执行取得。

## 保守裁定与尚未验证

1. 历史授权后若没有新的可信正常逻辑日标记，钱包事件也保持未知；不能伪造日标记补齐。首次启用当日可能要等自然逻辑日事件，快照独立可用。旧GM没有统一标记，当前过滤不能提供完整防作弊证明。
2. 120ms截止覆盖内部HTTP、body读取与解析，最多8并发；超时未知。首版不加跨轮缓存，避免旧授权/旧数值复用。记录单次本机时延，不把一次测试称为生产P95/P99保证。
3. 30秒及运行中10–15秒采样为本轮建议，安卓尚未确认；游戏逻辑日若与CST自然日不同当前保守降级，需联调规则而不是服务端擅自修正。
4. 新索引首次创建耗时、实际生产数据规模和网关路由尚未验。默认关仍有增量DDL成本，发布前需处理，见 [ROLLBACK.md](ROLLBACK.md)。总调度应与当前真实运行源码逐文件合并，本树15份现役差分不可整树覆盖P2。
5. Android新上报未开发验收、真机未报新快照、实际语音回答/断网恢复/多设备现场隔离未验；无生产部署、无新增线上合成事件。夜批、搜索三SN及窗口、倾听与Rust RTC保持本轮开始状态。

下一步：总调度复核并处理现役类型/测试例外→隔离预发与网关核验→安卓实施合同→目标SN受控真机验收→再决定放量。原始对话/凭据/完整账号身份没有写入交付件。

署名：codex（OpenAI）| 2026-10-31
