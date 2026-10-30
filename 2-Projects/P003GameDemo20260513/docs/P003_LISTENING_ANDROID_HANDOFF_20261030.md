# P003 倾听模式：Android 端云联调合同 v1

状态：2026-10-30实施协议；底座已开发，生产路由/音频接线与端侧联调尚未完成。**不能据此认为服务器已可调用，也不能在现役包声明能力后直接放量。**

目标：用户讲故事、分享或唱歌时，小可持续听，普通停顿不抢话；用户邀请后回复一次，再回到倾听。复用现有LiveKit/Rust/STT链路。

## 1. 端侧交付范围

| 必须实现 | 行为 |
|---|---|
| 能力声明 | 新会话`supports`加入`listening_mode_v1`；只有实际实现本合同的APK才声明。主Brain还须验证SN范围、当前账号归属、Worker能力与总闸。 |
| 控件 | “讲故事 / 分享 / 唱歌”“听听小可怎么说”“结束倾听”；显示准备中、正在倾听、正在反馈、已暂停。 |
| 本地声音 | 入模即停本地衔接短语、缓存回复、待播放队列；与Worker同步前不提示“已进入”。本地ACK音/报错语也受同一模式限制。 |
| 持续输入 | 保持RTC麦克风和流式STT；修改普通聊天idle自动退出、命令词、提示音策略，不能因几秒停顿退房。 |
| 歌唱控制 | 首版只以按钮申请反馈/退出，不以歌词问号、歌中的“小可”“再见”等词触发。 |
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
| `listening.enter` | `scene, mode_epoch` | normal初始epoch=0；只接受当前epoch的进入请求 |
| `listening.local_ready` | `mode_epoch` | Android确认本地声音及队列已清理；使用enter.received的epoch |
| `listening.feedback` | `mode_epoch` | 显式申请一次反馈；用户正在说话时拒绝，不排队到以后突然开口 |
| `listening.exit` | `mode_epoch` | 正常退出；paused要求关闭旧会话再建立普通会话 |
| `listening.state` | 无 | 用新seq查询最新状态，不重复执行旧动作 |

最近32条已接受命令缓存内，同seq同payload返回当前状态且`duplicate=true`；同seq不同payload拒绝。更老seq拒绝，序号高水位不清空。被拒绝的请求不算已执行，用户纠正后以新seq发送。

语音邀请由Worker经模式/场景判断后走内部许可入口，不冒充Android seq。具体语义检测属于后续接线任务，纯状态机测试不证明语音识别已实现。

## 3. 两阶段ACK

响应拟用`type=listening.ack`，payload包含：`version, request_id, command_seq, stage, state, mode_epoch, scene, listening_id, duplicate, reason`。

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
- 上述是端到端验收要求，当前底座测试只覆盖状态/许可/缓冲逻辑，实际声音总门尚待接线。

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

署名：codex（OpenAI）| 2026-10-30
