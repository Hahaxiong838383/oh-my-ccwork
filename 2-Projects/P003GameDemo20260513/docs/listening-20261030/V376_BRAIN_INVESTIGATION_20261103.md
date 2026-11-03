# v376 倾听联调：Brain 历史取证回执

**结果：Brain 侧历史签票、设备范围和语音能力已核实，未发现足以解释本次无 proposal 的 Brain 缺陷；Worker修复候选已通过本轮源码及三组隔离RTC复核，产品仍未完成真机验收。** 本轮不修改业务源码、三个冻结合同或生产配置，不部署、不重启、不唤醒设备。

取证：2026-11-03 10:13–10:22 CST。代码基线 `eeac0a68ef9886487958fdb5780d60474b8357ff`，原分支 `codex/p003-listening-brain-20261030`。启动时工作区干净。

## 1. 历史证据与结论边界

原始客户端回执测试窗口为 **2026-11-02 19:52–20:01 CST**，早于当晚 v375 后端发布。附件 SHA256 为 `aac82635aee578d14664f9470abb322303a676733a8858c82056278874c32ddf`。

| 核验项 | 实际证据 | 能说明什么 |
|---|---|---|
| 身份 | 主 Brain `devices.db/device_session_log` 中附件 trace `af4602f5-6491-45a3-9e5e-ee1cefb44af4` 唯一命中，19:57:23.471 签票；尾号03800006。SN/room SHA 与39独立采集的 Worker journal 映射一致 | 不是仅凭旧名单猜设备 |
| 配置历史 | `config.db/listening_settings_audit`：11/2 18:08:28.760 保存 rev6，enabled=true、仅03800006、story/sharing/singing、voice_invitation_enabled=true；至测试结束无后续配置版本 | 当时具备配置资格；不是拿今天 ready 代替历史 |
| 历史能力 | 8次成功签票均仍有 `listening_sessions` 权威记录，均含 `listening_mode_v1`、`listening_voice_control_v1` 及 `voice_control.version=1` | 两能力真实进入主权威登记；不只是客户端自报 enabled |
| 派单 | 8条签票日志 selected，agent=`p003-search-listening-20261030`，registered=true，健康租约余量7633–12587ms；权威登记 build=`b663e0e09d423ba282e21e242569774466fcfdb0` | 未见派到普通旧 Worker 或因健康门降级 |
| 授权有效期 | 两次倾听尝试分别签于19:58:02.041、19:59:20.478，grant期限20:28:02、20:29:20；上层窗口截止11/4 17:58:31 | 两次 final 时尚未达到已登记截止；不证明后续租约请求成功 |
| 进入记录 | 对上述8个 session 查询 `listening_entries/listening_requests` 均为0，8条 session仍保留 | 没有已持久化的进入/模式租约证据；不能排除未落库的失败HTTP尝试 |

`source_generation=0` 是主权威数据库内部变更计数；派单日志 `canary_generation=v374-listening-ark-20261102-1793613511` 是候选窗口标识。二者属于不同字段域，不能因不相等判错。

语音能力登记的签发前提包含核准构建、可信 Worker 注册、配置 revision/SHA ACK 和设备凭据/registry 检查。该结论由保留的登记记录、配置审计和实际源码条件共同推得；**没有保留下每次 worker-ready HTTP 原文，不能将其称为逐次ACK抓包**。

### 两次倾听尝试的对齐键

| CST 签票 | trace | session | 授权 |
|---|---|---|---|
| 19:58:02.041 | `3c770bf4-2eb6-4bf6-8cc9-38ab3970b77e` | `bb7eca3c-5bd1-4be3-97ca-a4e7e700a991` | 两能力、voice_control、正确agent/build |
| 19:59:20.478 | `172f1281-3387-4401-b697-de5456ed5534` | `c9ab6927-3364-49f4-a6e8-b1519b045f74` | 两能力、voice_control、正确agent/build |

39提供的脱敏 journal 形态证据已经读取并交叉核对身份、时间及源码指纹：19:58:13 的2字 final 仅唤醒词；19:59:32 的9字 final 不含唤醒词或“听”，均未命中原有限口令。各自 final 与普通 commit 文本摘要相同。修复前现役 `listening_voice.rs` 要求完整呼名口令，因此这些证据**不支持“推荐完整口令已被服务端识别，却被 Brain 拒绝”**。这批历史日志不能单独说明声学切分层或完整口令端到端情况；后续隔离正对照见第6、8节，真人仍待验证。此处不转发用户原话。

## 2. 协议检查与39协作

- proposal 沿既有可靠 RTC `control` topic，`src=worker`；Android仍唯一分配 control seq。Brain 不发送 proposal，签票后识别/提议属 Worker 层。
- Android必须以当前房间的服务端 AGENT kind、`attributes[lk.agent.name] == response.expected_agent_name` 验证并锁定实际 sender identity；不能把调度名直接等同 `agent-<job_id>`。本轮未取得 Android 实际校验执行证据。
- proposal 3000ms仅约束首次接受；enter接受后沿原进入超时；state查询不消费 pending proposal。三个合同均未改字节。
- 原合同 `recognition.normalization` 明确呼名开头、拒不完整前缀、仅final触发，**没有逐字要求同一条final**；单条final匹配是当时Worker实现限制。“近期唤醒后无呼名同义句”超出原有限词表。本轮以主13后续明确决定为新识别语义基线，唱后反馈、引语、歌词和权限门保持。
- 已交39本树新构建的既有 RTC harness，复用真实签票/authority/worker-ready/config ACK，`Date.now`、独立SQLite、合成身份及确定性文本provider。39独占真实RTC房间和进程启动/清理；本38没有启动真实RTC会话。

测试包 `rtc-brain.mjs` SHA256：`952e58ac01c278836ee7466f771cf0bc10469dbddb2bc0c344c4e22f7424848a`；manifest：`84e01a52c929b806d1d991fdfb67ff621edeecde5600258bc714a24acfd7263c`。65个源码输入及两份资产已重新核SHA。此包是隔离测试入口，不是生产发布包。

## 3. 现役差分与恢复点

11/3 10:16 当前管理只读响应：rev6、ready=true、applied_revision=6、active_sessions=0；仅作为该时刻状态。当前主进程PID3937878，候选Brain PID3913718，未作变更。源窗口截止仍为11/4 17:58:31，本轮没有延长。

线上185个 `src/**/*.ts` 与本树对撞：124相同、37不同、24本树缺失；这只是文件指纹差分，不是37个缺陷。差异包括BLE绑定、微信、Ark、搜索和埋点。已逐项核实 **v375提交 `856552b9` 的21个发布目标全部与当前线上一致**，admin SHA为 `c4a47f1025247df39cf80be421c7e2f58f64a269d0eb74e2dd07909485cf1634`。

关键保护点：实际 `listening-authority.ts` 比本树多 `acceptsDeviceBindingCredential` 检查，`device-session.ts` 多 `noteBleActivation` 及绑定版本返回；这些是现役BLE功能，不应回退。历史签票成功也说明本次身份通过了当时授权链。

**本Brain无业务源码候选、无需生产回滚。** 如后续确有源码修复，必须基于实时现役精确差分发布，不能整树覆盖。Git基线 `eeac0a68` 只供撤销本轮文档；线上真实备份仍由主13发布记录管理：`/opt/p003/backups/v374-ready-20261102`、`/opt/p003/backups/v375-tiering-20261102T135555Z`，禁止把本树Git版本当线上回滚包。

## 4. 本轮实测与可复跑入口

在本树 `apps/server`，Node v24.19.0：

```sh
node --experimental-sqlite --import tsx --test scripts/listening-http-contract.test.ts scripts/listening-authority.test.ts scripts/listening-integration.test.ts
node --experimental-sqlite --import tsx --test scripts/listening-rtc-brain.test.ts
node scripts/listening-rtc-prepare.mjs /private/tmp/p003-v376-brain/rtc-brain.mjs
```

结果：首组32通过、0失败；入口隔离回归1通过、0失败。涵盖合同、能力交集、旧客户端降级、鉴权/短租约、真实回环HTTP签票与独立SSE内容、配置ACK及撤权。身份、凭据、数据库和provider均为隔离测试用途，不等于真实Android/真实模型/扬声器验收。无业务源码变化，未重跑全项目或声称新增红绿修复。

协调目录：`/Users/fu-121/.local/state/p003-v376-coordination-20261103/`。

- `STATUS-38.md`、`brain-integration.json`：阶段状态和39可直接使用的入口。
- `evidence-38/historical-brain-summary.json`：脱敏签票、权威记录、配置审计、日志行号/摘要。
- `evidence-38/current-readonly.json`、`source-drift.json`：当前配置及源码指纹；完整差分留此处。
- `evidence-38/verify-38.py` → `verification.json`：可复跑身份/房间摘要对撞、8会话资格、现役v375 21目标、合同/测试包一致性检查。
- `brain-targeted-tests.log`、`rtc-entry-tests.log`：本轮实测日志；`verification.json`记录其SHA。
- 原始私有身份映射只留0600证据文件，不进Git、不外发。Nginx本次所读日志未检出倾听内控路径，但未确认该路径日志覆盖，**不把零行当作没有请求**。

## 5. 未完成与安卓最小下一步

1. 初版交付时待39跑完整口令隔离RTC正对照；后续证据与批准的修复范围见下节。固定候选及真人结果仍须各自验收。
2. 白天或真人在场，用新RTC会话清晰连续说“小可先听我讲个故事”，紧接叙述；按同trace记录proposal_id、Android seq/request_id、可信sender校验结果及ACK顺序。无声仅凭听感不能证明已进入。
3. 再跑一次反馈→回倾听→语音退出→下一句普通聊天，以及唱后明确呼名、歌词不误触、断网/超时；不绕过夜间无人门禁。
4. 钱包null/0与normal快照归45线；本轮不补写余额、不混算方舟通过。主13统一验收/部署。

## 6. 修复前对照与主13决定（11/3接续）

38已读取39的完整口令正锚与分段负锚原始证据包，核对相同测试Worker/Brain SHA：完整口令实际收到enter/exit proposal并完成进入；“小可”与“先听我讲个故事”两final相距3.145584秒时proposal=0、后半句普通commit。两房均有Room API absent记录。该对照使用真实RTC/ASR/TTS、合成WAV、Android软件替身和确定性文本provider；不证明历史真机原声必然同因，也不等于真人实听通过。测试二进制来自 `980b6482`，四个相关核心源码与现役 `b663e0e0` 相同，不能称同一现役可执行文件。

主13已在协调目录 `MAIN-LISTENING-FIX-DECISION.md` 明确批准：当前可信能力会话、最近明确唤醒后的**15秒单次有限自然enter**，覆盖“先听我讲个故事”“我给你讲一个故事”等明确请求；旧完整呼名继续支持。下一实质final若为普通聊天立即正常处理并消费窗口，partial不得无限续期；跨房/会话/epoch、失效权限、取消/结束均不得继承。15秒识别窗口不延长Brain grant/lease，也不改变proposal的3000ms首次消费规则。

此决定替代38之前仅建议5秒拼接的临时方案。39实施，38审固定候选，13验收与统一部署。本节仅记录修复前对照与批准范围；新候选复核见下节，**未上线**。三个冻结JSON字节保持。

补充证据：协调目录 `evidence-38/rtc-cross-review.json`、`38-review-alignment.md`。39的 `final-readonly.json` 已确认实际测试Worker2369474、启动器2369473和Brain2369459均退出，原清理疑点关闭。

## 7. 固定 Worker 候选独立审查（11/3 11:20 CST）

源码候选 `70d5f98a8f4d3e4aceca00890271a7bd7a1b6f3d`（前置 `cb892576`，恢复基线 `980b6482`）。38逐项阅读5个差分文件及后续2行有限词表扩展，没有修改Worker树。自然enter增加“我想给你讲个故事/一个故事”；不是任意语义分类，也不允许无近期唤醒的自然句直接进入。

| 审查点 | 固定源码事实 |
|---|---|
| 时间与一次性 | RecentWake保存runtime单调钟截止和mode epoch；14999ms可用、15000ms失效；明确wake最多刷新一次，partial只查询；下一实质final无论是否命中均消费 |
| 当前身份与权限 | 复用job的当前participant生命周期/音轨门，Adapter独占状态；voice capability、grant未过期、Normal、voice_invitation及scene门保留；新房无继承、暂停/关闭清理 |
| 两种输入路径 | ordered WakeOnly和普通RTC final均经同一echo gate后才建立上下文；重复呼名复用已有is_wake_only；普通final返回原聊天路径，不等待15秒 |
| 原控制协议 | 只发Worker proposal，不伪造Android seq；3000ms首次消费、合法state查询不消费提议、Brain lease及local_ready/completed保持；反馈与退出仍沿旧完整呼名规则 |
| 边界 | 有限短语，保留引语/歌词/否定/含义询问等已列负例；不宣称文本规则零误触或真实扬声器通过 |

38从两个固定Git SHA分别提取纯Rust源码独立运行规则测试；最新 `70d5f98a` **7项通过、0失败**，包括新增自然表达、9.982秒/15秒边界及旧口令。最新Linux构建manifest的86项输入逐个与该Git SHA核同；三个冻结合同字节未变。39最新匹配该SHA的Linux日志记录566+29+9+7＝611项通过、2项HTTP joint另行实跑均通过，test-feature隔离transport专项1项通过；38核了输入SHA与日志，不冒充独立重跑全套。正式release无test features，交付二进制SHA `27a72325f781e37d1114f91b58feb53bfd38de4b1e6ec2ca6453a7745bcd5e86` 已本地实算核同，HK2只读ldd无缺库。

可复跑：`python3 /Users/fu-121/.local/state/p003-v376-coordination-20261103/evidence-38/verify-worker-candidate.py 70d5f98a8f4d3e4aceca00890271a7bd7a1b6f3d`。证据 `evidence-38/70d5f98a-review/result.json`、`input-check.json`；最新RTC逐事件核验见下节；源码/规则测试不单独代表端到端通过。

本38仅文档交付，恢复点 `472606b058f7051ace5bba92b730c624d4d3e2e7`。若需撤销此次文档，按本次提交精确revert；不触及生产、业务源码或另一工作树。Worker候选回滚及真实现役文件仍由39/13交付和核对。

## 8. 最新候选真实RTC复核与交付边界（11/3 11:38 CST）

三包均明确编译源码 `70d5f98a`、同一test-feature二进制 `1fda3c073fbc7a110186d36fabbeb45fe33838780eabd5fbfa9e85d114b6ea1a`；实际进程PID2379825、Brain包仍 `952e58ac…`。客户端脚本SHA与固定Git一致。38逐条验证签发绑定、服务端AGENT kind/调度名锁定实际identity、proposal、Android替身seq、received/local_ready/completed、退出normal、反馈provider与房间删除事件，而非只读passed字段。

| 样本 | trace | 实际证据 |
|---|---|---|
| 完整呼名 | `p0-39-dbd3d108-5e5a-4939-96eb-9bc4d9b541ed` | 原口令进入成功；10项客户端断言通过 |
| ordered唤醒→RTC后半句 | `p0-39-0be6d460-7307-4813-96a1-5af9348deabe` | final为“小可”→“先听我讲个故事”，日志内final间隔3334.469ms；11项断言通过 |
| 延迟自然请求 | `p0-39-a48449c0-b9e6-4767-b516-568a2da2430c` | final为“小可”→“我要给你讲一个故事”，实际间隔12147.18ms，处于15秒内；11项断言通过 |

每房均收到enter和exit proposal，首次消费分别9/10/14ms；State查询后enter仍有效，随后Brain租约与local_ready双确认完成。每trace恰有一次反馈provider请求且包含即时续讲标记，退出后普通聊天有音频/字幕/metrics；三个房均有Room API absent。Brain观测为累计文件，38按该单并发测试的时间窗筛选，未把上一房的租约误计到下一房。

旧split负例proposal=0，新split完成握手，识别后的ASR两句相同。旧manifest未登记wake/enter_tail WAV SHA，故只认同类输入与实际ASR形态的前后对照，**不宣称音频字节完全相同或多轮稳定性通过**。延迟样本使用重复呼名合成音频，但实际ASR首final只有“小可”，不能称真实RTC已检验“小可小可”final；重复呼名代码路径已有定向测试。

历史9字请求仅在HK2进程内送入新parser，源码指纹核同70，原文SHA仍 `f72a2cffbcf2647bf902ca1e5b848ca63fd2cdbd53f489fd0f1377d99244b483`，得到story；没有导出原文，也没有把此结果冒充历史房间发生了新proposal。

可复跑核验：协调目录 `python3 evidence-38/review-final-rtc.py rtc-final-full-bundle.json`，另两包替换为 `rtc-final-split-bundle.json` / `rtc-final-natural-bundle.json`。三份脱敏复核JSON、原包SHA、输入核同与测试结果已并入本回执同目录的 `evidence/v376-brain-verification-20261103.json`。

**本轮结论：Brain不需要业务改动；Worker固定候选在此次隔离条件下通过独立复核，可交13继续发布验收。** 未替代真实Android、真实用户原声、扬声器/麦克风声学误触、唱歌实听与长期运行验证。实际RTC用了真实ASR/TTS/SFU、合成WAV/身份、Android软件替身、确定性文本provider；测试feature与正式release二进制分开记录，后者未由38启动或部署。

下一步最小真人动作：13按单038原范围验收部署后，Android新房先测完整呼名，再测单次唤醒后10–12秒自然请求；留同trace的可信sender、proposal_id/seq/received/local_ready/completed证据；接续叙述应保持安静，明确反馈一次后退出恢复聊天。测试一条普通问题应即时走聊天并消费窗口，再次无呼名故事句不应复用旧窗口。不延长原窗口，不增加设备。

最终已读取39 `final-after-tests-readonly.json`：实际Worker2379825、启动器2379824、Brain2379812均 `/proc` 不存在；与前次只读记录对撞，三生产unit的PID/启动时间/运行binary SHA及窗口文件SHA完全相同。清理疑点已关闭。38未操作生产；这只是本次取证时点事实，不是永久状态。

署名：codex（OpenAI）| 初版2026-11-03 10:22 CST；接续更新11:42 CST
