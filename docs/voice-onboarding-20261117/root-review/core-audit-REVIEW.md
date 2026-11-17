# 会话373固定候选独立只读审计

结论：固定候选发现两项新增 P2 缺陷，均有独立最小复现；不建议将该候选判为联合验收通过。没有修改373工作树、部署、SSH、全局配置变更或真实资料写入。

- 审计候选：`bf2b37d563ff749d82fca24282ed5878740f3e4e`。
- 实现提交：`1cf9428e19ce482e6b9958821837c9a845e2572f`；与候选的 Brain/Rust src 无差异。
- Brain 基线：`18a230754941ad9781db4d39e5a12a9622fc7349`。
- Rust 基线：`262dfe9c0a7bc9c44769670e0312bcb66cb32671`；已对比 control/job/pipeline 增量。
- 审计开始时工作树 git status 为空；12:06收尾时发现主代理并行补修的两个测试文件修改（voice-onboarding.test.ts、voice_onboarding_tests.rs），HEAD和上述生产实现仍为固定候选。审计助手未修改373树。以下文件行号均指固定候选。

## 1. P2：非姓名回答会作为昵称落库，后续课程永久视为已知

定位：`2-Projects/P003GameDemo20260513/apps/server/src/voice-onboarding-store.ts:84-103`，尤其89行的 `m?.[1] ?? s`；实际写入路径331-347行。

条件与复现：孩子年龄、性别已知，仅缺昵称；begin返回missing=[nickname]。孩子听到“我怎么称呼你呢”后答“等一下”或“再说一遍”，没有任何称呼声明。extractAnswer退回把整句当姓名，既有黑名单未拒绝这些句子，step真实更新SQLite并返回saved/missing=[]。“算了”“拒绝”也会同样保存。

影响：普通对话会将这些话作为孩子称呼；后续教学因nickname非空而跳过，不会自然修正。与“拒绝/含糊回答不写”的合同及本模块保守抽取注释不符。此抽取器和落库路径均为本次新增，不是基线问题。

独立证据：

- `brain-extra-probe.mts`：直接导入候选生产store，用随机临时SQLite库和合成身份调用issue/begin/answer。
- `brain-extra-probe-node22.log`：Node v22.23.5，四句均实际保存为nickname、返回saved；脚本末尾清理临时库。
- `brain-extra-probe.log`：Node v24.19.0得到相同结果，Node22复核为主。

修复边界：非称呼的等待、重述请求、拒绝不能走裸名回退；不要求引入模型或远端服务。明确称呼“我叫星星”“你可以叫我星星”和正常裸名“星星”继续可用，模糊句维持waiting_answer，明确拒绝走declined。应补实际SQLite断言：不改变nickname、不发saved。

## 2. P2：幂等重发 audio_complete 会清除真实语音资格，吞掉合法答案

定位：`2-Projects/realtime-voice-agent/rust-worker/src/voice_onboarding.rs:439-447`，特别444-445行；Session重复请求仅重发缓存状态的路径184-187行。生产ASR final丢弃点：`src/pipeline.rs:2034-2038`；提交时Runtime.answer还会在449-451行再次拒绝。

条件与复现：ask_age的audio_complete已被服务端处理，阶段为waiting_answer；孩子随后有新VAD语音活动，Runtime.speech使reject_asr=false。在ASR final到达或回合正式提交前，端侧按合同重发同一个audio_complete（例如state下行丢失后的3秒重试）。Session返回相同revision、相同状态，没有推进课程；Runtime却因为effects非空无条件清speech_seen，随后reject_asr=true。孩子已经说完、没有新VAD时，真实final或已缓存待提交答案被静默丢弃。

影响：合同要求的正常幂等重试改变输入状态，丢失答案；可进静默退出。该Runtime和门禁为本次新增，不是四项平台基线失败。

独立证据：

- `rust-probe/src/lib.rs`：外部crate直接include候选生产control.rs与voice_onboarding.rs，只替代无关FinalStats结构。通过公开Session/Runtime建立真实waiting_answer，不mock门禁、缓存或control实现。
- `rust-replay-probe.log`：证明state重发前后完全一致，fresh answer rejected从false变true。
- `rust-replay-red.log`：期望重复回执保留新语音资格的断言失败，测试0通过/1失败，退出101；其余38个原测试被过滤。
- 编译使用候选既有Rust1.100工具链及锁文件，依赖缓存复制至独立审计目录，offline；独立CARGO_TARGET_DIR，没有修改或复用373的target产物。

修复边界：清语音资格应由实际状态/音频轮次转换决定，不能由“需要回发缓存状态”决定。重复begin、旧audio_complete重放同样应无输入副作用；首次进入waiting_answer/新cue开始仍须清旧VAD，保留播音回声和迟到ASR隔离。无需修改客户端合同。

## 已审范围与未报告问题

- 已读CLIENT-CONTRACT-v398、CONTRACT-GAPS、SERVER_HANDOFF、TEST-RESULTS；检查Brain store/runtime/routes、profile-store/prompt-orchestrator/device-session增量及Rust控制/状态机/入口增量。
- 未发现新增证据支持“按父账号取错孩子”判断：现有profile设计父账号下也存孩子档案，POST /profile同步使用upsertProfile，普通基础资料修改保留新增自述年龄；copyProfile用于复制/换绑时清旧年龄有明确用途。
- 已核代码存在绑定版本/唯一档案/全快照校验、同步事务后saved、身份/trace/session校验、grant之外Worker鉴权、新session撤旧授权、单课固定期限、取消后不消费迟到reply；本审计没有发现这些方面额外可复现的新增绕过。
- 现有全部自测由主代理另行复跑，本审计不将作者20/38通过当作上述缺陷不存在的证据。
- 已知四项Rust macOS平台失败不记为新增问题。真实AEC、退出cue短词回声、RTC丢包与9秒租约、Android播放完成、供应商/Worker真鉴权、Linux生产构建和跨库掉电边界仍需联合验收，本次不声称通过。

署名：codex（OpenAI）| 2026-11-17 12:06 CST
