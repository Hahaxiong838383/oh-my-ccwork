# P003 倾听模式：Android 端云联调合同 v1

状态：2026-10-30语音优先接续。**Brain新语音协商/反馈授权已实现并隔离验证，Worker语音管线由39交付，Android尚需实现下面的自动控制流程；未部署、未开总闸、未验真机。** 09:50:48只发布管理后端，10:17:32发布顶部标签静态页。历史双方真实HTTP隔离对撞1项不等于本轮语音或真实Android/RTC通过。当前代码/合同SHA/证据与回滚见 [VOICE_ENTRY_RECEIPT.md](listening-20261030/VOICE_ENTRY_RECEIPT.md)。

新语音扩展：control/HTTP仍version=1，mode合同voice_extension_revision=2（HTTP/fixtures扩展修订1）。精确JSON样例在根目录 `4-Assets/contracts/p003-listening-mode-v1.json` 的 `voice_examples`；不另造控制通道。日常进入、反馈、退出均以语音为目标，旧按钮仅兼容/调试，不是使用前提。

目标：用户讲故事、分享或唱歌时，小可持续听，普通停顿不抢话；用户邀请后回复一次，再回到倾听。复用现有LiveKit/Rust/STT链路。

## 1. 端侧交付范围

| 必须实现 | 行为 |
|---|---|
| 能力声明 | 新会话`supports`加入`listening_mode_v1`；完成自动控制能力后再加`listening_voice_control_v1`，并核本次`listening_contract.voice_control`真实返回；只有实际实现本合同的APK才声明。主Brain还须验证SN范围、当前账号归属、Worker能力与总闸。 |
| 控件 | 日常无需触屏：消费可信Worker提议后自动发送原控制包；可显示准备中、正在倾听、正在反馈、已暂停，保留原按钮兼容。 |
| 本地声音 | 入模即停本地衔接短语、缓存回复、待播放队列；与Worker同步前不提示“已进入”。本地ACK音/报错语也受同一模式限制。 |
| 持续输入 | 保持RTC麦克风和流式STT；修改普通聊天idle自动退出、命令词、提示音策略，不能因几秒停顿退房。 |
| 歌唱控制 | 新协商会话：唱后停顿，明确呼名“小可，我唱完了，请给我反馈”才申请一次反馈；语音退出恢复聊天。旧包仍按钮；歌词问号/普通“再见”不触发。 |
| 断线/超时 | 显示连接或暂停状态；旧会话关闭后重新签发。不能因网络异常静默恢复普通抢话模式。 |
| 真实回执 | APK versionCode/versionName、完整SN（私下交接）、trace/session、操作时间、同RID ACK、实听结果。文档不附Bearer或用户原始故事。 |

后台与端侧都完成后才安排单机测试。当前本机封存v274源码不代表同事维护的现役APK，本项目不从封存包替端侧发布。

## 2. 控制消息

复用现有`control`可靠有序DataChannel。外层`trace_id`必须与服务端签名job一致，服务端使用LiveKit实际participant验证`dev-<完整SN>`；不能只相信`src=android`。

序号为本job trace内单调递增、安全整数1..9007199254740991；使用既有control序号分配器，不能给倾听命令另开相互冲突的序号。`request_id`固定为`trace_id + ':' + seq`，重传沿用原seq和完全相同payload。

```json
{"trace_id":"trace-test-1","ts_ms":0,"src":"android","type":"listening.enter","seq":1,"payload":{"version":1,"request_id":"trace-test-1:1","scene":"story","mode_epoch":0}}
```

示例为合成数据，真实`ts_ms`按既有协议填当前发送时间。`scene`允许`story|sharing|singing`。

| type | payload除version/request_id之外 | 含义 |
|---|---|---|
| `listening.enter` | `scene, mode_epoch`（新语音可选`proposal_id`） | normal初始epoch=0；只接受当前epoch的进入请求 |
| `listening.local_ready` | `mode_epoch` | Android确认本地声音及队列已清理；使用enter.received的epoch |
| `listening.feedback` | `mode_epoch` | 显式申请一次反馈；用户正在说话时拒绝，不排队到以后突然开口 |
| `listening.exit` | `mode_epoch`（新语音可选`proposal_id`） | 正常退出；paused要求关闭旧会话再建立普通会话 |
| `listening.state` | 无 | 用新seq查询最新状态，不重复执行旧动作 |

最近32条已接受命令缓存内，同seq同payload返回当前状态且`duplicate=true`；同seq不同payload拒绝。更老seq拒绝，序号高水位不清空。被拒绝的请求不算已执行，用户纠正后以新seq发送。

语音邀请由Worker经模式/场景判断后走内部许可入口，不冒充Android seq。当前Worker已编码语音邀请判断，真实语音识别/时序仍待当前APK联调；纯状态机测试不能替代该证据。

## 3. 两阶段ACK

响应使用已冻结的`type=listening.ack`，payload包含：`version, request_id, command_seq, stage, state, mode_epoch, scene, listening_id, duplicate, reason`。

- `stage=received`：Worker已禁止新输出、开始取消和清理旧播放。**不代表扬声器已静音或已进入倾听。**
- Android停止本地提示、已排队音频及播放缓冲后发送`listening.local_ready`。
- Worker确认旧capture任务退出、发送队列清空，并已收到local_ready，才发进入请求的`stage=completed`；回显最初enter的request_id/seq，状态为`listening`。
- `stage=rejected`含稳定reason；客户端不能把received或rejected当作completed。`listening_id`等于本次成功进入请求的request_id，整个故事保持不变；`mode_epoch`在取消/反馈/退出等状态转换时递增。
- 同一epoch允许entering→listening及feedback_reserved→feedback_active；两阶段完成不必新增epoch。可靠有序通道保证同代状态顺序；客户端忽略旧epoch回包，重连使用新trace。
- 3秒没收到received、或5秒没完成：用新seq查询状态，继续保持本地安静；拿不到可信状态则关闭会话并显示失败。不能自行宣称成功或恢复本地播音。

reason建议映射：`invalid_request / unauthorized / sequence_conflict / stale_sequence / stale_epoch / not_ready / user_speaking / close_required`。HTTP鉴权错误不得含secret/token/故事正文。

## 4. 状态与声音

`normal → entering → listening → feedback_reserved → feedback_active → listening`

任意倾听中状态遇租约撤销、到期或30分钟上限→`paused`。暂停时不播报异常，不回普通自动应答；结束旧会话后由用户重新发起。

- 普通叙述期间不调用普通对话LLM、不预生成回复、不播放filler；字幕/STT继续。
- 反馈需当前epoch及唯一turn许可。一次反馈完成、失败、被打断后都回倾听；用户开始讲话立即撤销许可，结束讲话不会恢复已取消音频。
- 反馈短、贴合实际内容，1–2句为软目标；不是每次都追加问题。没有可靠内容时不编造“我听懂整首歌了”，不据STT评价音准/节奏。
- 用户故事中的设备指令、金币交易、搜索、人格切换等不自动执行；后台旧搜索结果即使退出倾听仍需显式播放，不能补播打断。
- 上述是端到端验收要求。Worker代码已接输出总门并有隔离测试；真实设备的本地停音、双确认和扬声器听感仍未取证。

## 5. 上下文与隐私

会话原文最多12000字符、反馈近期窗口4000字符、摘要1200字符。摘要异步单任务，不阻止收音；按段seq/revision修订。旧摘要回包必须匹配room/session/trace/listening_id以及Worker保留的ticket实例/版本/原文前缀。

近期原文未被摘要覆盖却被截出反馈窗口、STT丢段或原文淘汰时，明确`has_gap=true`。不能把不完整上下文描述为完整记忆。已压缩段仅保存最近256条版本/指纹供去重；更老片段重传会保守作废摘要并标记缺口。默认不留原始音频，不自动写成长画像、事实记忆或人格。

## 6. 联调顺序与验收

1. 服务端离线/隔离环境：协议非法、越权、重放、跨会话、租约到期、在途capture、旧搜索任务及摘要修订测试；完整Linux Cargo与原聊天回归。
2. 端侧合成数据：入模中仍播音、local_ready缺失/迟到、按钮重复、讲话中申请反馈、网络恢复、过期会话等正负用例。
3. 单机真实验收：≥60条固定内容集，3×10分钟故事、3首歌、30分钟会话；普通停顿、人物对白和歌词不得触发回复/退出/硬件动作。
4. 同trace对账：操作→received→本地清理→local_ready→completed→用户讲述→主动反馈→实听→回倾听。服务端发送与扬声器实际听到分列，不能相互替代。
5. 普通聊天≥20有效对做同条件对照，正文首声中位增量≤100ms、P90≤300ms、零新增缺正文；保留慢例与失败。
6. 新→旧→新回滚演练后，按经核验完整SN开单机灰度；本合同不授权自动加入旧搜索两台设备或全量开启。

目前没有可用于倾听测试的线上服务端开窗。后续回执会给出实际发布SHA、目标SN范围、APK版本和开始/结束时间。

## 7. 安卓本轮最小接续清单（尚未交付验收）

| 项目 | 必须落实 |
|---|---|
| 能力 | 请求同时声明两项能力；响应无`voice_control:{version:1,capability:"listening_voice_control_v1"}`即降级，不假报全语音可用。此对象不包含新凭据。 |
| 信任绑定 | 收`control`可靠有序`src=worker,type=listening.proposal`，核RTC实际发布者为当前预期Worker、当前room/trace/session、目标participant=`dev-完整SN`和epoch；JSON的src不能代替身份校验。 |
| 自动回包 | proposal action=enter/exit，enter有scene；Android用原分配器取下一个seq/request_id，echo原`proposal_id`和epoch/scene；不得复用提议计数作Android seq。local_ready保持原格式。 |
| 幂等/到期 | 缓存proposal_id与原内容；同提议不重复分配seq或进入，控制重传沿用同seq/同payload。同ID改内容、跨房/代次丢弃。Android接收后最多3秒，不因重复延期；Worker创建后的3秒单调deadline是最终准据，不依赖端云时钟一致。 |
| 首句/连续收音 | 全新唤醒后的第一句即可进入；提议→enter→received→local_ready→completed全过程保持麦克风/RTC和idle策略；先停本地衔接语/所有队列再发local_ready。无额外确认音，不插入“好呀”。紧接叙述交Worker有限缓冲，不能回普通聊天。 |
| 完成/失败 | proposal到达≠received≠completed；原两阶段ACK仍有效。3秒未received/5秒未completed用新seq查状态，仍不可信则关闭并重建；paused/失效租约不能靠语音恢复旧会话。 |
| 反馈/退出 | 反馈由Worker原单次许可执行，不伪造Android按钮；新来源`voice_command`。退出自动发送原exit，completed/normal后仅处理下一句普通话题，不补播故事/旧反馈。 |
| 取证 | APK版本、设备、trace/session、提议ID、Android seq、received/local_ready/completed顺序、麦克风续流、本地清队列、实听结果。不得附Bearer、用户故事原文；先与39和主会话在隔离环境核同合同/commit，再单机实测。 |

最小实测顺序：新唤醒首句“小可先听我讲个故事”后立刻续讲→一次明确反馈→“小可结束倾听恢复聊天”→普通问题；再测唱歌/唱后口令、重复/迟到提议、引用对白/歌词、回声、断网。口令前的安静边界与口令后的讲话结束要分别取证；文本规则存在误识别风险，不能承诺零误触。Worker替身、MacTTS或HTTP成功均不能代替真机实听。

署名：codex（OpenAI）| 2026-10-30
