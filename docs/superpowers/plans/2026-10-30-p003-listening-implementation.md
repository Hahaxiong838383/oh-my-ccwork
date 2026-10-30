# P003 倾听模式执行计划

> 执行方式：使用 `executing-plans`，由 codex 亲自写代码；子代理仅只读调研/评审。按任务记录测试、commit及实际交付状态。用户2026-10-30已授权按方案开工，不重复询问是否执行。

**Goal:** 在现有Rust语音栈增加可控静默、一次反馈及故事上下文，并与Android完成真实设备闭环。

**Architecture:** 主Brain签发绑定会话的功能授权，Worker维护持久模式和逐次发言许可。普通叙述只进有界会话缓冲；摘要、反馈使用独立内部接口，不进入普通记忆/工具链。Android同步本地静音及持续收音。

**Tech Stack:** Rust/LiveKit、TypeScript/Hono、现有SQLite配置、现有STT/LLM/TTS；不迁Pipecat，不新增端点或全双工模型。

**Spec:** [已批准的设计基线](../../../2-Projects/P003GameDemo20260513/docs/P003_LISTENING_MODE_DESIGN_20261029.md)。原文“待批准”为10月29日状态；本计划记录10月30日执行GO。新功能上线仍须完成所列测试与端侧验收。

## 当前实施状态（2026-10-30接续）

Brain A/B已编码并由主会话复核52/45/38/12及tsc；Worker已编码真实control/pipeline输出门/异步HTTP，并有Linux508项及双方真实HTTP隔离对撞1项。38本轮整合已验收顶部标签、最小joint准备入口；39负责暂停后job收房P1。当前交付仍未部署或开闸，Android/RTC与真人体验尚待取证。09:50:48管理后端、10:17:32静态页分别记录，不能用本树旧HTML覆盖用户验收布局。最新commit/恢复点及复跑见项目`docs/listening-20261030/NEXT_BATCH_RECEIPT.md`。

下方任务列表及首批检查点保留原规划历史；不能把早期“未接线”当作最新代码状态，也不把工程隔离测试勾成真机/发布完成。本轮不扩展R26、长稳或全量上线范围。

## Global Constraints

- 普通Worker保R18＋style/ark，候选保R26＋style/ark；不得整树互相覆盖。
- 普通叙述期间普通LLM/投机=0、filler=0、未经许可输出=0、故事引起的设备/搜索动作=0。
- 首版不自动长期画像；唱歌按钮控制，不承诺音准/节奏评价。
- 总闸默认关闭、空名单关闭；无`listening_mode_v1`能力的设备不签发倾听授权。
- 背景短租约5秒刷新、单次1秒预算、15秒失效；后台撤权后≤16秒停止新输出为待测门槛，不阻塞音频循环。
- 独立回滚标签/文件清单/运行SHA；不整库回灌，不改原搜索范围或截止，不触碰个人语音与Analytics。
- 端侧由安卓同事维护：本会话交付协议、测试工具及回执，不从旧封存APK分支替同事发布新包。

## Review Focus

- 延迟capture在clear_buffer后再次送帧：任务4/7覆盖，enter.completed前必须完成清理。
- 同seq异内容、旧session、高seq复用request_id：任务1/2/3覆盖，拒绝而非重复开口。
- 歌词/人物对白触发退出、硬件动作：任务4/6/7覆盖；按钮为可靠入口。
- 二遍ASR修订已摘要片段：任务2/5覆盖，旧摘要不可覆盖新版本或丢原文。
- 退出倾听后Ready/Claimed搜索结果补播：任务4/7覆盖，旧结果必须保留显式播放要求。

## 工作区与冻结点

| 部分 | 工作树/分支 | 起点与冻结标签 |
|---|---|---|
| Brain | `~/.codex/worktrees/p003-listening-brain-20261030` / `codex/p003-listening-brain-20261030` | `e4bf0632` / `rollback/p003-listening-brain-20261030` |
| Worker | `~/.codex/worktrees/p003-listening-worker-20261030` / `codex/p003-listening-worker-20261030` | `ef92ee1a`（文件树同运行`8a343694`）/ `rollback/p003-listening-worker-20261030` |

Codeg登记：Brain folder28、Worker folder29，父folder12；名称“P003 倾听 Brain｜开发”“P003 倾听 Worker｜开发”。原会话继续保留，目录登记不等于自动复制历史。

10月30日07:54只读回查：普通/候选实际进程二进制SHA分别仍`a00744bf…bceb2d`/`680af65e…3ab8f9`，PID1546073/1545357；Brain读取到上一轮发布清单。尚不以清单代替所有当前源码逐文件校验；发布前补核触及文件。私有证据`~/.local/state/p003-listening-20261030/`。

## Task 1：冻结端云协议与发布门槛

Files：新增`4-Assets/contracts/p003-listening-mode-v1.json`（两树同字节）；Brain项目docs新增端侧联调文档。

Interfaces：既有control Envelope的trace/seq/实际participant身份保持；增加`listening.enter`、`listening.local_ready`、`listening.feedback`、`listening.exit`、`listening.state`。`request_id = trace_id + ":" + seq`，避免重新编码旧请求换seq重复消费；本次倾听ID与输出epoch分开；enter/local_ready/feedback/exit均校验当前mode_epoch。

- [x] 固化两阶段ACK、幂等/乱序、歌唱控制、停止本地音频、能力声明、缺确认及重连规则。
- [x] JSON语法、同字节SHA与样例验证；保存source基线/Codeg ID。
- [x] 提交协议与执行计划；不将协议冻结说成业务实现。

## Task 2：实现可独立测试的模式与上下文底座

Files：Worker新增`src/listening_mode.rs`、`src/listening_buffer.rs`、`tests/listening_core.rs`、`scripts/test-listening-core.sh`。

Interfaces：`ListeningMode::handle(Command, now_ms) -> Result<Snapshot, Reject>`；`capture_drained(epoch,now_ms)`；`begin_feedback(epoch,turn_id,now_ms)`；`feedback_done(turn_id,now_ms)`；`user_speech(now_ms)` / `user_speech_ended(now_ms)`；`renew_lease(version,until_ms,now_ms)`；`tick(now_ms)`。模式模块不解析JSON、不发送网络、不播放声音，调用者必须先完成鉴权。

`ListeningBuffer::upsert(seq,revision,text)`、`summary_ticket()`、`apply_summary(ticket,text)`、`context()`；字符上限12000、近期4000、摘要1200，修订/重复/过期摘要有确定行为。纯模块先不接生产主循环，不能单独上线。

- [x] 先写失败测试：默认普通、进入双确认、重复/乱序、单次许可、打断、租约到期静默、显式退出；不确定/非法输入不放行。
- [x] 运行`bash scripts/test-listening-core.sh`，见预期失败再实现，保存红/绿输出。
- [x] 写缓冲测试：中文字符界限、重复/修订、摘要CAS、超限、迟到修订、原文不进日志。
- [x] 核测试后提交；独立rustc测试不冒充完整Cargo/Linux/RTC验收。

## Task 3：主Brain策略与严格会话授权

Files：新增`src/listening-policy.ts`、`src/listening-grant.ts`、`src/listening-settings.ts`、`src/listening-settings-store.ts`、`src/routes/listening-admin.ts`、`src/routes/listening.ts`、`scripts/listening-policy.test.ts`、`scripts/listening-auth.test.ts`；修改`device-session.ts`、路由注册及admin-data。

Interfaces：管理配置`ListeningConfig(schema_version,revision,enabled,allowlist,scenes,tuning)`严格schema，通过投影提供`ListeningSettings(version=revision,enabled,allowlist)`；`eligible(settings,sn,supports)`；签发grant绑定room/session/trace/SN/account/expiry；`POST /v1/internal/listening/lease`返回主权威短租约。鉴权需要严格worker身份＋服务Bearer＋独立grant＋当前registry归属；缺secret拒绝，不用开发默认secret。

- [x] 先测试默认关闭/空名单/能力缺失/非法配置/版本回退，再实现纯策略校验。
- [x] 临时SQLite/Hono管理员GET/PUT、editor/guest拒绝、配置事务CAS/审计/历史恢复；旧会话签发回归保持。实现详见`2-Projects/P003GameDemo20260513/docs/listening-20261030/ADMIN_CONFIGURATION.md`。
- [ ] 测跨room/session/account、过期、归属变更、匿名、错误worker/服务凭据均拒绝；普通聊天不能伪装倾听。
- [ ] 运行device-session原45项与新用例；签发异常不误开放。提交此任务。

## Task 4：接入Worker输入、控制、输出与搜索

Files：修改`job.rs`、`control.rs`、`pipeline.rs`、`playout.rs`、`search_tasks.rs`；新增内部客户端模块。

Interfaces：metadata独立`Option<Value>`校验；模式状态持有任务2对象；`OutputPurpose`独立于history/search标记，反馈不能被误记为搜索。逐帧输出验证active许可；进程级租约刷新在后台，音频循环只读快照。

- [ ] 写现路径回归/失败用例，再接可信participant＋trace＋grant；未启用行为保持。
- [ ] 截获STT commit前的模式控制，保字幕final；禁止spec/ordered held-final预生成、设备/搜索/语音切档。
- [ ] 入模取消spec/warm/paused/deferred与在途音频；capture可取消，完成ACK等待本地与发送端双清理。
- [ ] 给旧搜索结果`requires_explicit_play`，退出不清；清pending_topic，候选后续补识别不得回灌旧epoch。
- [ ] 分离`record_history`与`is_search_turn`，反馈独立请求，不用Llm::chat_with_context有副作用历史路径。
- [ ] Linux全量Cargo、关闭模式回归、RTC竞态验证后提交。

## Task 5：独立摘要与反馈，不污染人格记忆

Files：Brain listening内部路由及提示模块；Worker listening客户端/缓冲；新增副作用测试。

Interfaces：`purpose=listening_summary|listening_feedback`，严格grant同任务3；summary返回版本和覆盖段；feedback沿现音色播放但无普通filler。输入不经过consumeFeedbackArmed/style/onboarding/persistTurn/extractor。

- [ ] 测吐槽arm未消费、普通对话/画像/成长库零变化、summary无需加载画像；错误token拒绝。
- [ ] 摘要单任务队列、3分钟/6000字阈值、失败与修订CAS；不阻收音。
- [ ] 反馈1–2句软目标/时长硬预算，正文失败/打断回倾听，不自动重播；不启用裸fallback绕过边界。
- [ ] 合成故事/歌词真实模型内容验收，统计普通LLM与摘要分别计费；提交。

## Task 6：后台与Android联调交付

Files：后台`apps/web/public/admin/index.html`；`docs/P003_LISTENING_ANDROID_HANDOFF_20261030.md`及协议fixture。

- [x] Worker Brain顶部倾听配置卡、保存/版本冲突/历史恢复/关闭总闸接口和真实浏览器验证。运行未就绪时禁止开启；配置修订与结构版本分开。
- [ ] 接入实际应用版本/会话状态/统计/租约撤权证据；当前null不伪装0，管理界面随整功能测试后发布。
- [x] 输出安卓端能力/按钮/持续RTC/本地静音/本地命令/idle与重连清单，提供seq与ACK正负样例。
- [ ] 安卓同事交付当前源码/候选APK能力与回执后，按相同trace联验；旧封存v274不能代表现役端侧。
- [ ] 端侧没完成或未取证时，服务端保持关闭，记录具体依赖，不能冒充产品可用。

## Task 7：双基线隔离验证与单机灰度

- [ ] 从届时实际候选运行基线建integration工作树，最小移植；不覆盖正在开发的搜索树。
- [ ] 跑固定≥60内容用例、每场景正负例、3×10分钟故事、3首歌、30分钟会话；指标按设计§10。
- [ ] 正常聊天≥20有效对，正文首声中位增量≤100ms、P90≤300ms、零新增缺正文；保慢例/失败。
- [ ] 新→旧→新回滚验证，候选路径白名单/租约主权威、TTL/额度/其他服务保持。
- [ ] 核目标完整SN与端侧能力后开单机灰度；现场实听通过再扩量。开窗、服务端发送与扬声器听到分别记录。

## Task 8：交付与归档

- [x] 本批未接线检查点只读独立审查，问题以失败→修复→绿套件关闭；整功能接线完成后还须再次审查。
- [ ] 提交push专用分支；回执列代码、测试、实际部署SHA、端侧版本、未验项与精确回滚。
- [ ] 更新项目记忆和共享记忆；不把源码push描述为已上线。

## 首批基础模块检查点（历史，当前状态见上方）

任务1协议与端侧合同、任务2独立底座、任务3纯策略/绑定JWT部分已写码；Task3的会话登记/内部HTTP鉴权与Task4–7仍待实施。本轮未接线/未部署，不是完整P0交付。29项Rust纯测试、10组Brain单测通过；缺陷均按复现→修复记录。

## 进度记录

详见项目`2-Projects/P003GameDemo20260513/docs/listening-20261030/EXECUTION.md`。任务完成仅在代码/测试证据都具备时勾选；端侧与真人验收是明确依赖，不用“开关已写”替代。

署名：codex（OpenAI）| 2026-10-30

早期配置追加归档：后台可调参见ADMIN_CONFIGURATION.md；随后管理后端和顶部静态标签已分别发布，运行接线已编码但未部署。Worker七项参数消费已有隔离测试，真实设备行为仍待验，不能只保存配置即算完成。
