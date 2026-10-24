# P003 R14 搜索对话连续性与跨会话续讲实施规划

> 执行者：使用 executing-plans 逐项实施；遵守用户要求，由codex本人编码，不委派。当前文档是待实施方案，以下复选框不代表已完成。

**目标：** 修复搜索结果被短附和打断后回旧话题、以及退出重进无法主动续讲，同时保持普通聊天无新增远程等待。

**架构：** Worker本地判定搜索播报期附和，保存可核验的句级播放进度；Brain接收本轮临时搜索阶段信息，并用独立短期恢复授权连接旧任务与新会话。网页正文仍留搜索任务域，普通聊天历史与长期记忆不接收它。

**技术栈：** Rust/Tokio Worker，TypeScript/Hono Brain，现有SQLite任务账本，LiveKit音频/字幕/metrics。

**设计依据：** [反馈复盘](../../../2-Projects/realtime-voice-agent/docs/search-tools-20261021/P003_SEARCH_R13_FEEDBACK2_ANALYSIS_AND_REPAIR_PLAN_20261023.md)。必须同时读本方案和反馈复盘，不能只执行接口清单。

## 约束与执行顺序

- 沿用Brain `codex/p003-brain-search-tools-20261021`、Worker `codex/p003-worker-tool-lifecycle-20261021`，不新建分支，不合main。
- Brain根B=`2-Projects/P003GameDemo20260513/apps/server`；Worker根W=`2-Projects/realtime-voice-agent/rust-worker`；均在各自工作树操作，不能把另一分支的同名目录当实现真源。
- 只改独立候选。当前SN范围为BJP00326060100100004、BJP00326070803800006；P1开、P2关；绝对截止2026-10-24 23:59 CST。执行时重核，过期不自动续窗。
- 普通聊天主循环不await搜索HTTP、恢复查询或LLM锁；不全局延长ASR判停、不忽略合法cancel、不改首句合同和端侧退出权威。
- 字幕/PCM/服务端账本/实体扬声器分层验收；所有“首帧”注明起点是commit还是停说。
- 原始用户正文、音频、凭据不进Git。测试用例用合成数据，故障证据只保存时间、ID、哈希与计数。
- 分三次可回滚交付：A=附和与阶段上下文；B=句级进度与跨会话；C=延迟观测/整体验收。B依赖进度和授权验证通过，不能只删cancelSession就开窗。

## 任务0：冻结合同与建立新的回滚点

文件：项目`PROTOCOL.md`（Brain现存）、新增当轮`R14_ROLLBACK`与源码/产物清单；Worker对应交付文档。

- [ ] 重新采集现役/候选PID、NRestarts、完整运行SHA、Brain文件清单、有效开关、三侧截止、timer、jobs和资源。调查快照只作对照，不作未来运行真值。
- [ ] 新回滚目录保存本次要覆盖的每个文件、资产、配置键旧值及元数据；验证备份确实覆盖变更路径。代码基线为调查归档后的两条原分支HEAD；运行基线是R13，不能用文档HEAD冒充部署SHA。
- [ ] 把“退出销毁一切”改为：退出取消未完成查询，已ready结果只有经新恢复协议才可被新会话显式领取；明确取消/替换/撤权仍彻底作废。
- [ ] 固定保留期限`min(readyAt+300000, windowDeadline)`；不因重连/领取/续讲延长；Brain重启清空恢复资格。首版不支持跨天搜索历史。
- [ ] 定义独立候选开关：Worker `P003_SEARCH_ACK_V1`、两端 `P003_SEARCH_CONTEXT_V1`、Worker `P003_SEARCH_RESUME_V1` / Brain `SEARCH_RESUME_V1`；全部默认关，只有已有搜索allowlist有效时生效。不开全局BACKCHANNEL_MODE。

## 任务1：搜索结果播报中的附和，不制造新聊天

文件：新增`W/src/search_dialogue.rs`；修改`W/src/main.rs`模块登记、`pipeline.rs`、`search_tasks.rs`；测试放新模块及pipeline测试区。

接口约定：

```rust
pub enum SearchAckDecision { ContinueResult, NormalInput }
pub struct SearchPlaybackContext {
    pub result_active: bool,
    pub first_pcm_seen: bool,
    pub input_continues: bool,
}
pub fn classify_search_ack(
    enabled: bool, text: &str, context: &SearchPlaybackContext
) -> SearchAckDecision;
```

`result_active`只来自带真实task/revision/delivery的搜索结果，不能用search_turn单独判断，因为ack/澄清/失败提示也共享该标记。`first_pcm_seen`沿正式播放事件设置，不是排队或合成已开始。

- [ ] 写失败测试：当前正在播结果、已出PCM、输入已提交且无后续语音，严格短附和应ContinueResult；普通聊天/结果未起播/提示音/新查询/设备控制均NormalInput。
- [ ] 首版精确集合为`嗯、嗯嗯、哦、哦哦、噢、唔、对、对对、是、是的`，先规范化再整句相等；不使用包含匹配，不加入“我/不/停/小可/然后呢”。复合句和新话题一律走正常流程。
- [ ] 在pipeline现有STOP/EXIT之后、hard_abort_current之前调用；命中时作废该附和投机，清理对应interim/判停状态，沿现有附和路径收尾字幕；被VAD暂停则恢复当前播放。不得新发承接音、chat请求、任务或user_turn_committed。
- [ ] start_speculation采用同一判定上下文，短附和投机不发网络。上下文未确定时允许丢弃投机，不阻塞锁。
- [ ] 活跃完整新话题立即沿原路打断；若附和后又有新片段，后续片段正常处理，不能把整个语音流静音。不得把所有短输入当噪声。
- [ ] 用实际0字LLM计数、33字搜索、150字搜索分别测试，不再依赖长回复120字阈值；验证v319字幕/等待状态不因“不起新轮”进入异常自动退出。

核心测试形状：

```rust
assert!(matches!(classify_search_ack(true, "嗯", &SearchPlaybackContext {
    result_active: true, first_pcm_seen: true, input_continues: false,
}), SearchAckDecision::ContinueResult));
assert!(matches!(classify_search_ack(true, "嗯，换一个话题", &SearchPlaybackContext {
    result_active: true, first_pcm_seen: true, input_continues: false,
}), SearchAckDecision::NormalInput));
```

## 任务2：补本轮阶段上下文，保持网页与记忆隔离

文件：`W/src/llm.rs`、`pipeline.rs`、`search_tasks.rs`；新增`B/src/tools/search-dialogue-context.ts`；修改`B/src/routes/custom-llm.ts`；新增`B/scripts/search-dialogue-context.test.ts`。

请求附加字段，**不是messages中的system消息**：

```ts
type SearchDialogueContextV1 = {
  protocol: 1;
  task_id: string;
  revision: number;
  phase: 'running' | 'ready' | 'playing' | 'interrupted';
  dialogue_epoch: number;
  resume_grant?: string; // 恢复后的新会话必须验证本会话grant，不能绕过旧task所有权
};
```

- [ ] 写失败测试，覆盖当前custom-llm会忽略Worker system消息的事实；新增字段必须在正确认证/候选/allowlist下生效。匿名、非目标、错误room/task/revision/phase或关闸时忽略字段，不阻断正常聊天。
- [ ] Worker只带当前任务的本地枚举快照；不等待任务查询。变更状态时更新dialogue_epoch；投机缓存核销同时比较history_version和dialogue_epoch，旧阶段投机作废。
- [ ] Brain通过现有认证身份与本地SearchTasks记录核对scope；恢复后的请求改用本会话ResumeGrant验证，不能读取旧会话任务。只从枚举生成固定提示：本轮紧邻后台搜索，含糊输入应澄清；不自动补答之前闲聊悬而未答的问题，不虚构已查到的事实。
- [ ] 固定提示只拼到本次systemPrompt；不改userText/history、不送conversationStore或memory-extractor；不把网页正文或来源塞入该字段。显式新话题仍优先回答，不持续锁在搜索主题。
- [ ] 验证输入字段大小、整数范围、UUID、允许phase；浏览器自行伪造不能注入任意文本。禁止用客户端system角色注入绕过现有Brain组装。
- [ ] 测试mock provider看到阶段提示，而mock conversationStore/extractor看不到；无字段请求与开关关闭请求的消息/调用次数保持原合同。

## 任务3：句级播放游标，先解决“有音频却0字”

文件：新增`W/src/search_progress.rs`；修改`pipeline.rs`、`playout.rs`、`search_tasks.rs`；新增对应Rust单测；`B/src/routes/search-tasks.ts`收取版本化进度。

```ts
type SearchProgressV1 = {
  protocol: 1;
  text_digest: string;
  complete_sentences: number;
  sequence: number;
};
```

- [ ] 写受控流测试：合成尚未结束、已有PCM出队时abort，仍有已知全文与句界，游标不能因synthesize未返回而丢失。
- [ ] 将可信搜索结果按句界切分，短尾合并，建立全文digest与句序；注册文本元数据早于首PCM。只在已有播放采样足以跨完整句末时推进complete_sentences；未完成句从句首重播，不使用字符比例切进半词。
- [ ] 句界统计与字幕共用分段，播放轨顺序不变；只对搜索结果启用。不要为了进度把每几个字各发一次TTS，导致连接次数或正文首帧增加。
- [ ] 进度在异步队列发送；按delivery、sequence单调接受，约束cursor不超句数/digest匹配。每个完整句一次，加退出最终快照；不逐PCM网络上报。
- [ ] 不直接把现有played_samples当精确游标：它取开播墙钟与captured的较小值，未单独扣暂停/欠载。搜索游标以成功capture的累计样本减RTC队列安全尾量为保守下界（当前200ms队列取220ms余量，队列配置变化须同步）；自然排空且收尾等待完成才确认最后一句。pause/abort不得凭墙钟推进，测试暂停2秒、欠载和clear_buffer。播放器采样是服务端证据，需考虑RTC缓冲尾部；无可信完整句时游标保守回退，允许重复当前句，不允许跳过未确认句。报告不称逐字无缝或真人已听到。
- [ ] 测试合成前/首PCM后/半句/句界/完整播完/重复回执/旧delivery迟到；取消后任何进度不得复活结果。

## 任务4：5分钟内新会话显式恢复

文件：新增`B/src/tools/search-resume.ts`、`search-resume-scope.ts`；修改`search-runtime.ts`、`search-tasks.ts`、`B/src/routes/search-tasks.ts`；修改`W/src/search_tasks.rs`；新增`B/scripts/search-resume.test.ts`、`search-resume-scope.test.ts`及Worker HTTP模拟测试。

恢复记录在Brain候选内存中仅保存任务引用与游标，不新增网页内容进入对话库；任务结果仍受现有5分钟清理。Brain重启使恢复资格失效，明确提示重新查。旧任务没有新scope版本时不补授权。

```ts
type ResumeScope = { subject: string; candidate_account: string; authority_epoch: string };
type ResumeRequest = { protocol: 1; request_id: string };
type ResumeGrant = {
  id: string; task_id: string; revision: number; session: string;
  result_until: number; text_digest: string; complete_sentences: number;
  state: 'claimed' | 'completed' | 'interrupted' | 'revoked';
};
```

新增端点合同（沿用现有内部认证和body上限）：

- `POST /session/close`：关闭原会话，取消queued/running；ready/已播结果在scope合法且原期限内保留引用。重复close幂等。
- 原`POST /session/cancel`继续强取消语义，不偷偷改旧客户端行为。
- `POST /resume/latest`：接收ResumeRequest，由当前认证room获取最近可恢复条目，创建绑定新session的ResumeGrant；响应附受限待播文本与剩余绝对期限。
- `GET /resume/:grant/playback`：校验grant归属、scope、期限、开关、task/revision/digest；供Worker领取后复核，不开放旧`/:taskId`的跨session访问。
- `POST /resume/:grant/receipt`：接收outcome和SearchProgressV1；按grant+sequence幂等，过期/撤权/旧session迟到拒绝。

实施步骤：

- [ ] 先为28秒退出重连场景写失败测试，并证明旧get/playback的跨session拒绝仍保留。
- [ ] scope由服务器构造：完整SN＋候选账号＋**现役台账当前授权纪元**。候选devices.db已证实是独立文件，不能只读其历史绑定快照。
- [ ] 新建最小只读台账reader，从配置指定的现役devices.db读取status/account_id/parent_account_id/updated_at及credential撤销水位。采用现有`DatabaseSync(path,{readOnly:true})`模式、busy_timeout≤50ms；只在搜索后台API使用。将字段哈希为authority_epoch，原账号/绑定值不下发Worker，不复制画像或写现役库。
- [ ] 字段缺失/台账不可读/禁用/授权纪元不匹配时仅拒绝恢复，不阻断普通聊天。使用updated_at是保守策略：后台修改非归属信息也可能使短期恢复失效；后续可另做专用绑定版本，首版不改生产表结构。
- [ ] 提交新搜索时固定scope；接单成功才将“最近一条”替换，失败的新查询不能删除旧可恢复结果。明确取消、合法改查、撤权、关闸/到期对任务和所有grant一起作废。
- [ ] 原会话未关闭时不允许新会话偷取播放。close与resume竞态返回409 `previous_session_closing`，Worker最多后台重试一次，间隔500ms，总预算2秒；不在音频循环等。旧close不能取消新session的grant，须用task/revision/source-session精确比较。
- [ ] request_id重试返回同一grant，不重复领取；不同request_id最多沿现有8次人工重播上限，同SN同时一个活跃grant。新会话退出后释放当前grant，保存最新可信游标；旧receipt只能影响旧grant。
- [ ] Worker给Speech增加delivery_scope区分原session与恢复grant；轮询、回执、撤权路径走各自端点。不得用原`/:id/playback`偷渡新的session。
- [ ] 只有明确resume且本地无可用remainder时调用新入口；重连本身不请求、不自动播。恢复执行可和普通聊天并行，结果仍等待现有空闲门；取消/改查通过epoch废弃迟到恢复响应。
- [ ] `SearchSession::Drop`只能作最后兜底；正常关房在job清理时显式发送最终进度与close，设置有限后台收尾预算。即使最后回执丢失，也按最后已确认句界降级，不泄漏、不无限重试。

核心验收断言：

```ts
assert.equal(recovered.session, newSession);
assert.equal(recovered.result_until, originalReadyAt + 300000);
assert.equal(recovered.complete_sentences, lastConfirmedSentence);
assert.throws(() => originalTasks.get(newOwner, originalTaskId), /not_found/);
assert.equal(repeatedRequestGrant.id, recovered.id);
assert.equal(cancelledResume.status, 404);
```

还必须测试绑定A→B→A、凭据撤销、跨设备、并发两次重连、旧close/旧receipt迟到、数据库只读失败、进程重启、窗口到期及结果过期。缺任何授权证据都不放开恢复。

## 任务5：把慢样本的阶段证据补齐，不盲目叠加竞速

文件：`W/src/tts.rs`、`tts_xfyun.rs`、`pipeline.rs`、`llm.rs`；必要时`B/src/routes/custom-llm.ts`仅增加脱敏阶段观测。不得顺手换模型/音色或加新厂商。

- [ ] 为17:57半句插话保留独立未结项：对齐同trace的端侧上行长度/ASR final顺序；完整语音只上传了部分时转端侧修复，完整上行而识别缺失时查ASR，后续文字已到而Worker丢弃时再修Worker。未取证前不改全局EOU或把缺字补成想当然文本。
- [ ] 将TTS等待开始、连接就绪、首PCM时刻挂到能覆盖abort/Drop的观测器，不能只在synthesize成功返回后打印总耗时。
- [ ] 每轮携带room/turn/task及同一单调时钟锚；记录route耗时、LLM请求→首字、TTS等待、provider首PCM、播放排队、结果ready→首PCM。日志不记正文/签名URL/凭据。
- [ ] 为两类独立慢样本加可控假时钟/阻塞future测试：LLM慢但TTS早已好；LLM快但预连接慢；同时慢；两端均快但播放等待；在每阶段取消。
- [ ] 已有限备用握手保持并发2、延迟650ms及不排队策略，先看证据再调整。不得通过无界连接/重试争抢普通聊天资源。
- [ ] 普通聊天同音频A/B至少20对，包含短句/长句/连续话题/搜索运行中/恢复进行中，每组串行；报告全部样本和超3秒慢轮。预设门槛为配对中位增量≤100ms、配对增量经验P90≤300ms，并且聊天路径无新增等待搜索的样本。小样本P90仅发布检查，不写稳定P95；未过门查因或回滚，不重跑到变绿后丢失败。

## 任务6：混合对话验收、候选部署与回滚

按下表准备完整连续序列，合成与真人同编号。所有话术为测试模板；没有听到/没有实际执行不能标通过。

| 组 | 输入/事件 | 必须看见 | 必须不发生 |
|---|---|---|---|
| A1 | 先聊宠物取名→澄清搜索→主题和谓语间隔0.6/1.0/1.8/3.0秒 | 有效范围内合并为一次目标查询；超合并窗口明确澄清 | 同题chat+search双答、回旧宠物话题 |
| A2 | 搜索播报中分别轻声附和、静音、背景噪声 | 严格附和继续当前结果；无输入不新起轮 | 旧话题新答、重复提示、幽灵查询 |
| A3 | 播报中完整说换话题，或附和后接取消/改查 | 新意图正常打断、优先执行 | 吞掉真正插话或控制 |
| A4 | 普通闲聊中的同样短词、搜索澄清提示时的短答 | 原普通聊天和澄清行为 | 全局附和策略被改变 |
| A5 | 插话分成半句和尾句，完整语音与服务端转写比对 | 保留每段证据；不把缺失文本补成“已听见” | 为等待任意尾句全局加时 |
| B1 | 结果半句中断→同会话续讲 | 从保守句界续讲 | 因synth未结束而游标丢成空 |
| B2 | ready后30秒/2分钟/4分59秒退出重进→明确续讲 | 同SN同归属恢复，期限不变 | 新会话空槽直接报无结果 |
| B3 | 退出重进后只普通聊天 | 正常聊天 | 自动播放旧结果 |
| B4 | 取消/合法改查/5分钟到期/窗口到期后恢复 | 明确无效或过期；无旧PCM | 旧任务复活、延长TTL |
| B5 | 换SN、绑定变化、旧回执迟到、并发重连 | 拒绝越权和重复领取 | 设备/账号串结果 |
| B6 | close丢包/回复丢包/Brain重启/未知进度 | 幂等或明确降级 | 无限重试、声称已播未证实部分 |
| C1 | 天气、恐龙、天文、博物馆、新闻与闲聊连续混合 | 每条对应任务/话题/来源，空闲补播和取消正常 | 只靠天气一条通过充全量 |
| C2 | 相同20对普通聊天WAV，含搜索/恢复在后台 | 延迟门槛与所有慢轮留档 | 用提示音首帧替代正文首帧 |

- [ ] Brain新增与既有search-tasks.test.ts、search-route.test.ts、search-boundaries.test.ts、search-canary-isolation.test.ts回归、TypeScript检查；不改凭据或生产数据跑测试。
- [ ] Worker在既有home-studio Linux构建目录核源SHA后跑全Rust测试、路由预览测试、release构建和glibc/ABI门；本机edition2021诊断不替代此门。失败保留关闭状态。
- [ ] 部署前确认无真人活跃job；必要维护只关闭原候选派单，不能中断现役。完整产物字节数/SHA对撞后安装，不整树覆盖Brain、不整库回滚。
- [ ] R14→R13→R14回滚演练，分别验健康、鉴权、任务数据兼容与原设备范围；新增内存恢复记录清理，旧任务账本保留。A/B开关独立可退，不把代码回退误写成用户结果可继续。
- [ ] 合成RTC串行、间隔≥30秒，探针使用独立trace并在真人占用时让位；每例对齐输入/路由/task/播放授权/PCM/字幕/metrics，结束确认jobs清零。
- [ ] 截止仍有效且前置全过，才恢复原两台P1，不开P2、不提额、不扩面；若已过截止，保持关闭并报告需要新窗口时间。
- [ ] 发新真人用例回执到Air Downloads并核SHA；标“待真机验收”。本次5和10必须真人分别确认，其他用例按是否本版重测标注，不能沿用R12通过记录冒充R14全过。
- [ ] 代码、脱敏部署记录、测试结果、回滚说明分别commit＋push现有分支并核远端SHA；更新项目MEMORY与README入口。

## 预计效果与验收限制

A完成后，搜索播报中的严格短附和不会另起聊天并接回旧问题，完整插话/控制仍有效；B完成后，5分钟内重进主动续讲可从句级进度恢复，可能重播当前未完成句；C完成后能按阶段判断长尾并阻止普通聊天回退。以上是待实现目标，当前R13尚不具备新增能力。此次不承诺消除所有ASR误识别、端侧自动退出或上游网络/模型长尾。

## 2026-10-24执行接续

本轮联合实施A/B与C观测，代码已部署独立候选并演练回滚。普通聊天23对配对中位+2.1ms、P90+4555.7ms，发布门未通过；三侧关闭，无新窗口、无延期。核心合成链路与最终版本各项结果见项目R14_ACCEPTANCE_20261024.md/R14_TEST_RESULTS_20261024.json，待真机验收。上方规划复选框不是本轮完成证明，不能把未做的实体/负载配对项目勾通过。
