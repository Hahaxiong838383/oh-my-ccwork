# P003 指定 SN 搜索灰度实施与实机验收规划

> 执行方式：codex 本人使用 executing-plans 逐项实施；不委派代码任务。复选框表示待完成项，不是已通过记录。

**目标：** 仅让指定内测设备进入候选语音链路，在真实音频、字幕和任务账本上验证后台搜索，再决定是否扩大范围。

**架构：** 保留现役 Worker；独立启动候选 Worker 与候选 Brain。会话签发层按经认证的完整 SN 选择 agent，候选 Brain 使用独立数据目录。Git 分支隔离代码，agent 名称与鉴权隔离会话，两者缺一不可。

**技术栈：** 现有 Node/Hono/SQLite、Rust/Tokio、KidsHubAI-VoiceKit 派单、HTTPS 反向代理。

**依据：** [候选交付](../../../2-Projects/P003GameDemo20260513/docs/search-tools-20261021/README.md)、[协议](../../../2-Projects/P003GameDemo20260513/docs/search-tools-20261021/PROTOCOL.md)、[验收边界](../../../2-Projects/P003GameDemo20260513/docs/search-tools-20261021/ACCEPTANCE.md)。

**执行更新：独立候选、HTTPS、隔离/期限代码及生产最小签发补丁已部署；正式两小时设备窗口未开，待真机验收。**

当前事实见 [R1部署与验收记录](../../../2-Projects/P003GameDemo20260513/docs/search-tools-20261021/CANARY_ACCEPTANCE_20261021.md)。下文“现状”表和旧冻结点是实施前快照；本轮执行前SHA、当前PID/哈希与测试证据均在R1记录。

## 2026-10-21 20:11 授权变更（优先于下文历史规划）

用户已确认完整SN `BJP00326070803800006`、现场v353（1.2.2-canary.339），并授权开启目标设备搜索，供10月22日全天体验。取消“同机30轮基线先完成才开窗”的体验前置：普通聊天对照由其他设备提供，不能把跨设备对照冒充同机P95结论。首轮2小时限制改为本次显式固定截止2026-10-22 23:59 CST；代码三侧36小时硬上限、持久到期关闭，不自动滚动续期、不扩设备。P2仍等P1真机通过后另开。

此项是用户对验收安排与时长的明确更新；真实实听、质量、插话与全天长稳仍记待真机，不能记为已经通过。实际开窗时间、版本与R3恢复点在新回执/技术记录落盘。

## 1. 分支安排：继续现有两条，不新建第三条

| 责任 | 分支 | 工作树 | 规划前冻结点 |
|---|---|---|---|
| Brain、会话签发、灰度入口、验收总账 | `codex/p003-brain-search-tools-20261021` | `/Users/fu-121/.codex/worktrees/p003-brain-search-tools-20261021` | `c12720d079956965b2aa7368d667c0c362e7b96e` |
| Worker、隔离运行配置、播放与取消证据 | `codex/p003-worker-tool-lifecycle-20261021` | `/Users/fu-121/.codex/worktrees/p003-worker-tool-lifecycle-20261021` | `928dd9fdfee3de4a90130e9d6a64bffe4e8c8f1f` |

SN 灰度是当前搜索功能的上线验收阶段，直接依赖这两个候选，不是独立产品功能。沿用分支可减少重复补丁和版本混淆。两条分支来自不同生产基线，不能整树合并凑成一条；发布按目录、逐项提交选择。以后若冻结一个候选同时并行开发其他功能，才从冻结 SHA 新建版本分支。

原 `mycc/main` 工作目录不切换、不清理、不提交无关修改。每一实施任务独立 commit；开始前保存两分支 SHA，构建后记录源码清单、二进制 SHA、配置摘要和部署批次。禁止对共享主仓或生产目录执行 reset --hard。

### Codeg 可见入口

- 文件夹 21：Brain；会话 [P003 搜索 Brain / SN 灰度｜历史快照](codeg://session/24)。
- 文件夹 22：Worker；会话 [P003 搜索 Worker / SN 灰度｜历史快照](codeg://session/25)。
- 原始历史：[小可AI语音对话](codeg://session/13)，仍在 mycc。
- 两副本通过官方 thread/fork 与 Codeg import_selected_sessions 生成；截止到本轮操作前最后完成的对话，分别回读 2152 条展示记录。它们是完整历史快照，不是实时镜像；后续新增消息不会三处同步，原会话不移动、不覆盖。
- 两个入口后续均可继续开发，但避免同时启动同一范围的写操作。涉及双端的协调与验收结论以 Brain 分支本规划和交付 README 为入口。

## 2. 已核到的能力和必须补齐的差距

| 项 | 现状 | 本阶段动作 |
|---|---|---|
| 独立 Worker 名称 | `rust-worker/src/config.rs` 已支持 `AGENT_NAME` | 候选命名 `p003-search-canary-20261021`，不得与现役相同 |
| 设备认证 | `device-session.ts` 检查 Device Bearer sub 与 body.device_sn 一致 | 沿用；完整 SN 精确匹配，不用末 8 位鉴权 |
| 会话派单 | 当前由默认 rust-worker 与既有首句策略选择 agent | 增加独立搜索灰度规则；保留首句能力合同、JWT、响应自检的一致性 |
| 搜索双侧开关 | Brain 热开关和名单、Worker env 名单已实现 | 两侧仅放指定 SN；先关闸回归，再启 P1，最后启 P2 |
| 候选 Brain 入口 | Worker 搜索接口固定 HTTPS 主域名、443 | 用同域独立路径转发候选，保持域名校验和 TLS；不放宽为任意 URL |
| 数据隔离 | 目前只有搜索账本独立 | 候选账号/设备/人格/配置等所有存储也要隔离，禁用定时写入；不是仅换搜索 DB |
| RTC 证据 | 单测、构建、Search/Fetch/Tool Calls API 已测 | 实机音频、字幕、延迟、取消与持续运行未验；必须现场取证 |

拟沿用设备 `BJP00326070803800006`（末 8 位 `03800006`）。这是计划目标，开窗前重新核对云端 MCU、Device Bearer sub、实际 APK 版本及联网状态，不把历史 v325/v328/v345 当当前版本。

## 3. 会话与数据隔离设计

1. 现有认证、SN 许可和限流全部通过后，先按原逻辑算 `baselineAgent` 与首句 `contract`。
2. 新灰度条件同时成立才覆盖 agent：总闸开、完整 SN 在名单内、配置未过期、候选身份固定、候选健康租约有效、候选声明支持当前首句合同。其他情况返回原 agent；不修改原首句策略开关，不借用其名单。
3. 同一个选择结果同时写入票据 `roomConfig.agents[].agentName`、响应 `expected_agent_name` 与断言。禁止新票据派到旧 Worker 后才尝试转交。
4. 灰度仅影响新建会话。目标设备结束旧会话并重连后生效；现有房间不会热迁移。签发后进程仍可能故障，健康检查不能承诺零失败：候选离线时新会话回旧路径，已签票据按 TTL/客户端重连处理并记录。
5. 拟新增独立路由前缀 `https://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1`，反代剥离前缀至候选 `/v1`。候选 Worker 的 `LLM_BASE_URL` 指向此处；普通聊天和搜索都走候选 Brain。精确拒绝相似前缀、跳转和不在计划内的路径。
6. 候选进程只监听 loopback；端口在部署前按现机占用选择并固化，不凭文档猜空闲端口。公网前缀保留原鉴权，并加候选身份/目标 SN 限制；仅改 Worker env 不是访问控制。
7. 候选使用独立服务目录、DB、音频目录、日志和账号映射。测试账号可导入目标设备所需的最小设置及人格只读快照，原始长期记忆不全量复制；测试写入只进候选目录。候选不挂载生产 DB、音频发布目录，不启动 Analytics、自动人格提取或音频定时生成。
8. 搜索专用 Worker 通行证只保存在私有配置；如签发层共用现役密钥，权限仍由角色/accountId/SN 三层校验限制。禁止复制真实儿童正文到 Git、Codeg 新消息或公开回执。
9. 单机候选 `WORKER_MAX_JOBS=1`；在现有机器上做进程隔离仍共享 CPU/网络，必须先核资源余量、限制资源并观察现役指标。余量不足才安排独立主机，不预先认定需要换服务器。

## 4. 实施任务与改动位置

以下 `server/` 指 Brain 工作树的 `2-Projects/P003GameDemo20260513/apps/server/`；`rust-worker/` 指 Worker 工作树的 `2-Projects/realtime-voice-agent/rust-worker/`。列出的新增开关和文件是拟实现项，目前不存在的不能按已可用执行。

### 任务 A：Brain 的 SN 派单策略

文件：新增 `server/src/search-canary-policy.ts`、`server/scripts/search-canary-policy.test.ts`；修改 `server/src/routes/device-session.ts`；扩展 `server/scripts/device-session.test.ts`。

- [x] 定义纯函数 `selectSearchCanaryAgent(input)`，输入 `sn, baselineAgent, nowMs, enabled, allowlist, expiresAtMs, leaseUntilMs, canaryAgent, contractCompatible`，输出唯一 agent 名称；异常配置一律返回 baselineAgent。
- [x] 新增热配置 `p003.search.canary.enabled/allowlist/expires_at_ms/agent`，默认关闭、名单空拒绝。健康租约由本机受控探测更新、有效期 15 秒、每 5 秒续约；请求路径只读内存状态，不等待联网探活。
- [x] 先写并执行以下决策表测试：默认关、名单空、错 SN、过期、租约过期、兼容性不符都返回 baseline；命中全部条件才返回候选；baseline 为旧首句专用 agent 时仍保留该回退值。

```ts
import assert from 'node:assert/strict';
import { selectSearchCanaryAgent } from '../src/search-canary-policy.js';
const input = {
  sn: 'BJP00326070803800006', baselineAgent: 'baseline-first-turn', nowMs: 1000,
  enabled: true, allowlist: ['BJP00326070803800006'], expiresAtMs: 9000,
  leaseUntilMs: 5000, canaryAgent: 'p003-search-canary-20261021', contractCompatible: true,
};
assert.equal(selectSearchCanaryAgent(input), input.canaryAgent);
for (const delta of [
  {enabled:false}, {allowlist:[]}, {sn:'BJP00326060100200003'},
  {expiresAtMs:1000}, {leaseUntilMs:1000}, {contractCompatible:false},
]) assert.equal(selectSearchCanaryAgent({...input,...delta}), input.baselineAgent);
```

- [x] 测试先失败后实现；集成用 `Hono app.request()` 与合成 Device Bearer，覆盖 body SN 伪造为 403、未命中设备保持原响应语义、JWT/expected_agent_name/contract 三方一致。
- [x] 执行 `node --experimental-sqlite --import tsx scripts/search-canary-policy.test.ts` 与 `node --experimental-sqlite --import tsx scripts/device-session.test.ts`；测试只用临时 DB。通过后独立提交。

### 任务 B：Brain 隔离启动与 HTTPS 路由

文件：新增 `server/src/search-canary-guard.ts`、`server/scripts/search-canary-isolation.test.ts`；按实际 store 清单修改 `server/src/index.ts` 及必要启动路径；新增 `server/ops/search-canary/README.md`、`nginx-location.conf.template`、`brain.env.example`（只写键与非敏感示例）。

- [ ] 检查所有 store 的 DB 路径、import 时副作用及 scheduler；新增启动断言，候选配置只能落在专用根目录，解析符号链接后仍不得指向生产。路径遗漏即拒绝启动。
- [ ] 给候选关闭定时任务及生产发布出口；不假设一个新 env 能关闭全部写入。用临时生产哨兵目录与候选目录启动，普通聊天、搜索、管理查询后断言生产目录内容/mtime 未变化、候选只写专用目录。
- [ ] 反代模板保留认证与超时、长连接能力；不记录 URL 中 token。验证主路由配置保持、候选前缀重写正确、非目标身份拒绝、候选停止不影响主路由。
- [ ] 首轮只在隔离环境运行上述测试与 `npx tsc --noEmit`、既有搜索测试；生产 `nginx -t` 和 reload 仅在 R1 备份及小范围部署阶段执行。反代配置通过不等于音频通过。

### 任务 C：Worker 灰度运行与可观测性

文件：核查/必要时修改 `rust-worker/src/config.rs`、`llm.rs`、`search_tasks.rs`、`search_policy.rs`、`pipeline.rs`；新增 `2-Projects/realtime-voice-agent/docs/search-tools-20261021/CANARY_RUNBOOK.md` 和独立服务模板。

- [ ] 原样保留 HTTPS 主域名和 443 校验，新增同域候选前缀单测；坏域名/HTTP/错误端口/URL 凭据/跳转全部拒绝。普通聊天、本地音频文本拉取与搜索均核对路径，禁止搜索偷偷回生产。
- [ ] 验证 `AGENT_NAME=p003-search-canary-20261021`、`WORKER_MAX_JOBS=1`、`P003_SEARCH_DEVICE_ALLOWLIST=BJP00326070803800006`；搜索初始 `P003_SEARCH_ENABLED=0`。从灰度票据验证真实房间 SN，客户端自述不能覆盖身份。
- [ ] 日志关联 `deployment_id/trace_id/session_id/task_id/delivery_id` 与毫秒事件；公开回执只保留脱敏关联 ID。禁止增加逐音频帧同步 IO 或输出正文/凭据。以 actual TTS start/end 和客户端播放证据区分生成、发送、实际听到。
- [ ] `cargo test` 后做与目标 ABI 一致的 Linux release 构建，保存源码清单和二进制 SHA。新的修改必须重新构建，不能沿用此前二进制哈希冒充当前产物。

### 任务 D：生产最小接入与回滚演练

- [ ] 重新读取现役 SHA、PID/重启数、配置、活跃 job 与资源使用。R0 是历史锚；现役有变化时先生成 R1，不覆盖别人的更新。
- [ ] 先部署独立候选 Brain/Worker，路由总闸关闭；验证候选健康、默认关普通语音、进程与数据库隔离。
- [ ] 共享签发服务只发布任务 A 所需最小补丁及直接依赖；不将整份候选 Brain 覆盖生产。可能需要现役服务 reload/restart，必须按真实框架在空闲窗口执行并回归。不能承诺生产零变更。
- [ ] 新反代 location 与候选入口就绪，验证其他 SN 仍返回原 agent。只观察现有其他设备，不为负测改它们的开关。
- [ ] 开窗前先演练：关灰度派单→新会话恢复 baseline；关搜索→在途结果不再起播；停止候选→主路由/现役 Worker 仍健康。所有操作留时间和证据。
- [ ] 双侧名单及派单名单仅目标完整 SN；窗口有显式截止时间，执行到期关闸测试。初次建议 2 小时，由实际开始时间计算，不沿用过期联调窗口。

## 5. 川哥如何拿实机体验

无需仅为搜索改动 APK 或重新安装；先验证当前版本支持现有会话合同、字幕与指标。如果能力缺失，再单列端侧补丁，不冒称现版本必然兼容。

1. 目标机器保持上电联网，提供当前版本与 SN 核对；端侧同事或川哥可用正常入口进入语音对话。
2. 开窗前采集同机旧版 30 轮普通聊天基线；设备结束旧会话，服务端开单机路由后重新进入。核对票据目标、房间、候选 Worker 接单三者一致才开始体验。
3. 先做关搜索的普通聊天/插话/退出/设备指令/本地回复语回归；通过后打开 P1（网页搜索）。
4. 说“帮我查一下今天北京天气”，紧接着说“我今天画了一只猫”，继续聊三轮。后台检索不得卡住正常回答，结果应在空闲后补充。天气只是体验样例，验收时核对城市、日期与实际来源。
5. 结果播报时插话“先停一下”；正常聊天后不能自发整段重播。再说“继续刚才的搜索结果”，检查续讲进度。极早插话的短段重复是已知待量测项，出现即登记，不能算完全通过。
6. 分别说“取消搜索”“改查上海的天气”，以及搜索中退出再进入。不得出现已取消/旧问题的迟到补播。
7. P1 通过再启 P2（Tool Calls＋受控 Fetch），至少一条实际 Fetch 与 tool_call_id 完整链路；工具选择未触发 Fetch 的样例不能算 Fetch 通过。
8. 使用屏幕录像/外部录音与客户端日志联合取证。只有服务端“已发送”不足以证明设备扬声器实际播放；人工说话与实际耳听保留现场观察，自动测试不能代替全部体验。

## 6. 验收门与证据表

下列是本次拟采用的放量门槛，尚未跑出结果；样本数量和统计口径一起记录，不用平均值掩盖尾延迟。

| 项目 | 样本/方法 | 通过条件 |
|---|---|---|
| 身份与隔离 | 目标 SN、另一合成 SN、伪造 body SN、关闸、过期 | 目标只到候选；其他沿用原策略；越权拒绝；没有双 Worker 抢同房 |
| 普通对话 | 同机基线 30 轮，候选关搜索 30 轮，后台搜索并行 30 轮 | 每轮有明确结果，无卡死/静默漏答；首声 P95 比基线增加不超过 max(200ms,基线20%)，按相同网络/配置对照 |
| 空闲补播 | 10 次搜索中连聊三轮 | 无打断用户/覆盖正常回答；满足 800ms 空闲门后起播；过期结果不自动补播 |
| 真实播音与字幕 | 至少 10 条完整结果 | 实际可听、字幕与播音内容对应；关联 task/delivery；无控制串、工具 JSON 朗读和重复完整播报 |
| 插话与续讲 | 早/中/末段各 5 次，连续打断 5 次 | 停播 P95 相比同机普通插话基线增加≤100ms；无进度倒退或自动重播；字级对齐未实现部分如实列出，不标全过 |
| 取消与替换 | 明确取消、改查、退出、断线、撤名单各 5 次 | 状态确认后不再启动旧结果；已播缓冲的尾音单独测量，不承诺瞬时撤回 |
| Search＋Tools＋Fetch | P1/P2 各 10 条，P2 至少 1 条真实 Fetch | 上游调用证据真实；预算/截止时间生效；拒绝非允许域名与网页指令；工具失败不编造查到 |
| 内容质量 | 20 个儿童常见问题，记录时效/实体/来源/可理解性 | 无严重事实或不当内容；至少18/20可用；不支持的结论明确不确定；问题不得仅用 API 文档样例代替 |
| 初轮长稳 | 2小时窗口、至少20次会话/100轮语音/20次搜索 | 崩溃和非预期重启0；任务无跨会话串台；过期后无积压；日志/队列有界 |
| 延长观察 | 初轮通过后单机24小时、含夜间及重连 | 内存无持续上升、无跨日迟到播报；实际样本量列出，低流量不等同负载验收 |

候选与现役同时留 CPU/RSS、丢帧/队列、语音首声、错误率。现役出现异常相关迹象即关候选搜索和新派单，排查资源影响；不以“不同进程”推断绝对无影响。

账本对账分开统计 queued/running/ready/failed/cancelled/expired、领取、播放 completed/interrupted/dropped/unknown，不把 accepted 或 ready 当播放成功。证据包含脱敏 CSV/JSON、构建清单、开关前后快照、客户端/服务端时钟偏差与关联 ID；敏感音频和原始日志仅放私有目录，提交报告不含原始用户正文和凭据。

## 7. 回滚与结束条件

1. 停止接收新的灰度会话，随后关闭候选搜索热闸。关派单只影响新票据，不会取消已有房间。
2. 目标设备退出候选会话并重连，验证已回原 agent；确认候选无 active job 后停候选 Worker/Brain。确需强停时先说明该测试机当前对话会结束。
3. 需要撤销共享签发补丁时，只恢复 R1 保存的对应文件和配置，不覆盖新业务数据；反代只撤本次 location，配置验证通过后 reload。
4. 保留候选账本及证据，不把候选 DB 回灌生产，不回退人格 revision、不改 Analytics 开关。
5. 收口输出实际开始/结束、SN后8位、APK版本、两端部署SHA、每项样本/通过/失败/未测、回滚状态；记录“单机通过”与“可全量发布”是不同结论。

## 8. 实施前范围快照（现状见R1记录）

两条分支与历史会话入口已就绪。本文件给出实施顺序、实机操作、通过门槛和回滚路径；具体候选路由、隔离启动、健康租约与新测试尚待实现。下一步在这两条分支亲自编码，测试通过后再安排单机窗口。没有自动扩大至其他内测设备的授权。

署名：codex（OpenAI）| 2026-10-21 北京时间
