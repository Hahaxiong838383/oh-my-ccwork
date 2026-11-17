# G2 v398｜语音交互教学服务端联调回执

2026-11-17。客户端已开发并部署当前开发机；**端侧与显式模拟通过，真实服务端条件问答、可信控制交付及记忆落库尚未验收**。请按下面完整合同确认/冻结后安排单机联调；本文件不是“云端已保存”的回执。

## 本次已准备好

- Android 正式构建提交 `dd9a58aeb5f4f17f42fada228e60e6dceb3ea70d`，v398 / `1.2.2-canary.384`。APK SHA256：`794efed1bc2cd0e47d3024f805026d17f646eb4fa66a61732c7bf9a5c58e3ed3`，89,477,185 字节，已保数据安装回读一致、六服务 6/6、无新增 Fatal/ANR。
- 教学表内六句、年龄/性别/称呼三句均已内置。服务端只选白名单 cue，不需要下载音频，也不要再同句远端 TTS；客户端以实际播放完成回执驱动。
- 九种真机“本地模拟”已通过：全部缺失、全部已知、提前唤醒、无唤醒、无回答、无回执、保存失败、拒绝和继续聊。明确 no_cloud/no_profile_write，不当成真实 ASR 或记忆写入。
- 当前线上缺少可选教学授权时，客户端有界释放本课暂停，保留普通聊天房。已验证同一 trace 不会在每次聆听/思考/说话时重复进入教学；切回旧缸不会回退当日准入。
- 第一次部件介绍结束才接设置；之后实际七次打勾、升级、次日新缸引导已跑通，自动语音教学不插入上下/跨缸导航。GM 清游戏档可重新测试，但不会删除云记忆或原设备绑定。
- 本轮未改服务器、白名单、全局配置、401 策略，未开注入，未发布后台 OTA。请沿用原绑定的当前单机灰度；设备云身份由你们既有鉴权记录核验，不使用 USB 编号。

## 普通真实语音抽测锚点（不是记忆保存证据）

|trace_id|实际结论|
|---|---|
|`1d71b3db-ac79-43a8-9f02-cf28168f6602`|ASR final、远端回答字幕、实际 PCM；教学入口一次|
|`ad462421-6ce1-4afa-a874-a05ba524f69c`|同上|
|`39c410d2-ce5c-440e-8d80-d31d25819749`|设置之前提前真实唤醒；完整回答后恢复原礼包，入口一次|
|`6d748fff-47ea-41e3-8f3d-ba34829ee930`|仅推进游戏日期至七天之后，系统钟未改；完整真实回答，入口一次|
|`b75ff5fd-49f9-4826-8484-b218dd45d496`|ASR final＋实际 PCM 后主动触屏退出；不以主动截断冒充完整回答|
|`d8839117-be3d-4daf-b773-cd5b9de7f408`|额外静默取景后问句接近原 5 秒空闲边界，未形成 final、按 idle_timeout 退出；原证据保留，不归因服务端、不算通过，随后及时输入复测通过|

以上是普通链路不回归的样本，不代替历史 ASR 异常矩阵验收，也没有声称供应商发送/返回或真实记忆落库已独立对账。

## 请服务端接手确认与联合验收

1. 确认下附可选授权、control 类型/lane、stage、request_id/revision 幂等、租约时长和七句服务端选播白名单；如有差异先书面列出，不原地漂移。
2. 服务端决定当前绑定孩子缺哪些资料、问什么及是否写入，不能变成端侧固定三题。年龄不擅自推算精确生日；`memory_write=saved` 必须在真实提交后。
3. 单机开启能力后联合覆盖：全部已知/部分缺失/全部缺失、拒绝、静默、保存失败、重复/旧回执、保留原房继续聊及倾听互斥。回传同轮 trace、request_id/revision、实际记忆提交结果，不回传明文个人资料或 Token。
4. 预制语音期间避免回声被当答案；等端侧 `audio_complete` 后再转 waiting_answer/waiting_exit。服务器不同步重复播同一句。
5. 完成上述真实链路后才能关闭服务器联合待办。客户端当前包可直接用于开始联调；若合同需变更，再按确认差异推进新包。

---

## 附：完整接口合同提案 v1（待服务端冻结）

状态：**客户端合同提案 v1，尚未服务端冻结；不得当作线上记忆写入验收通过。**
本文不含设备凭据、Token、完整云身份或 USB 身份。APK 与真机结果见最终验收回执。

## 1. 分工与用户已确认边界

- 客户端：首日设置引导后发起；提前真实唤醒可提前进入；静默提醒、退出、恢复原页面、次日补触发、GM 清游戏档重新触发。仅保存教学资格/完成/尝试日，不保存生日、性别、昵称或回答。
- 服务端：按当前绑定的孩子真实记忆决定缺哪些信息、问哪些问题、识别答案及条件写入；不是客户端固定三题问卷。已知内容不重复索取，允许孩子拒绝；普通聊天的随时补问仍由服务端决定。
- “你多大了呀”的年龄回答不能擅自换算成某个精确生日。生日精度与年龄语义由记忆系统决定，无法确定则保留未确认。
- GM 清游戏档仅重置本地教学，不删除服务器记忆、设备绑定、凭据或 Wi-Fi。服务端资料齐全时应跳过问题，继续完成退出教学。
- 不补发星尘；老游戏档不额外追补；首个部件介绍必须播放完成/有界失败退出后才衔接原设置引导。

## 2. 可选能力协商（现有鉴权不变）

既有 `POST /v1/device/session` 请求的 `supports` 新增 `voice_onboarding_v1`。
凭据响应原有 JSON 同层可增加：

```json
{"voice_onboarding_contract":{"version":1,"capability":"voice_onboarding_v1"}}
```

缺失、版本错误、格式错误均表示不支持：客户端释放教学暂停并继续普通聊天，不清凭据、不重建房间、不伪造资料已保存。不改既有 401/绑定策略。

## 3. 复用现有可信 RTC 控制通道

topic 上下行均为 `control`；沿用现有 envelope 的 trace_id/ts/src/seq/type/lane/payload。无需新 HTTP 记忆接口，也不让 Godot接触服务端 URL 或凭据。

上行：type=`voice_onboarding.request`，lane=`voice_onboarding`，payload：

```json
{"v":1,"session_id":"existing-session","lesson_id":"g1lesson_random",
 "request_id":"g1lesson_random-1","action":"begin","entry":"scheduled"}
```

- entry 只接受 scheduled / early_wake / next_day。
- action：begin / request_exit_prompt / audio_complete / finish / cancel。
- 每个动作一个 request_id；每 3 秒重发相同字节，最多 3 次，9 秒无应答释放端侧租约；服务端须按 request_id 幂等，不能重播/重复写记忆。
- lesson 为当前真实互动 trace 与 session 内的有界事务；新会话、霍尔/待机、系统覆盖、用户退出等均使旧事务失效。整课最多 180 秒，不被服务器状态续期。

下行：type=`voice_onboarding.state`，lane 同上，可信 worker 的 payload：

```json
{"v":1,"session_id":"existing-session","lesson_id":"g1lesson_random",
 "request_id":"g1lesson_random-1","revision":1,
 "stage":"question_speaking","memory_write":"none",
 "audio_prompt":"ask_age","audio_token":"question_1"}
```

- request_id 必须属于本课最近 8 个已发动作；revision 为整数 0..1000000、严格递增。同 revision 仅完全相同的阶段/写入摘要/音频标记可幂等接受，不能替换内容。
- Android 验证真实当前房间/worker participant SID/trace/session；旧房间、非可信来源、跨课、越序或不在白名单的消息不能驱动教学。
- stage：intro_speaking / question_speaking / waiting_answer / exit_speaking / waiting_exit / normal_chat / completed / failed / declined。
- memory_write 仅 none / saved / skipped；**saved 只能在真实记忆提交完成后发送**。不返回或投影孩子资料值、用户原话。
- 开始课与倾听模式互斥。倾听 proposal 由既有严格校验接管时，端侧撤销本课权限，不能留下两套持麦/空闲租约。

## 4. 预制语音在对应步骤播放

所有下列文件已用用户授权的同一音色生成，客户端 APK 内置。intro 与 wake_reminder 在真实唤醒前由客户端播放；其他七句由服务端**选择**白名单音频，不让客户端编排资料问答顺序。

|阶段|audio_prompt|文案|
|---|---|---|
|本地顺序入口|intro|嗨～我是小可，你的专属陪伴机器人，你可以说“小可小可”叫我出来，来试试吧。|
|本地一次提醒|wake_reminder|试着说“小可小可”，我就来啦。|
|intro_speaking|wake_reply|来啦！|
|intro_speaking|early_intro|来啦！我是小可，你的专属陪伴机器人。我们来聊聊吧！|
|question_speaking|ask_age|你多大了呀|
|question_speaking|ask_gender|指挥官是男孩还是女孩呀|
|question_speaking|ask_nickname|我怎么称呼你呢|
|exit_speaking|complete_exit|说得太棒啦！你可以和我说“退下”或者“不聊了”，结束对话。下次想和我聊天时，叫我“小可小可”，我就会出来啦。|
|exit_speaking|quiet_exit|你可以和我说“退下”或者“不聊了”，结束对话。下次想和我聊天时，叫我“小可小可”，我就会出来啦。|

使用本地预制语音时，发送对应 speaking 状态和唯一 audio_token（字母数字下划线/短横线，1..80 字符），**不要同时下发同句远端 TTS**。端侧只允许当前可信课/当前指定音频在远端播放已空闲时播放；其他普通提示不因此获得穿透语音门禁的权限。每课最多 32 个音频标记，已完成标记不能被重用来重播。

本地实际播放完成或失败后，端侧发新动作：

```json
{"v":1,"session_id":"existing-session","lesson_id":"g1lesson_random",
 "request_id":"g1lesson_random-2","action":"audio_complete","entry":"scheduled",
 "audio_token":"question_1","audio_status":"complete"}
```

audio_status 为 complete / failed。排队成功不算播放完成；缺文件、停播、音量门禁或超时不能假报 complete。服务端只在收到当前音频完成后进入 waiting_answer/waiting_exit，并在预制语音期间避免把播音回声当孩子回答。若采用远端动态语音，不带 audio_prompt/audio_token，必须等服务端输出完成且端侧真实 PCM 播放结束后才开始静默计时，不能混用两种输出。

语音包：`D:/P003交付/语音交互教学试听_20261116_v1.zip`。其中另外生成的章节卡片巡游语音仅备查，不激活用户已取消的首次卡片巡游流程。

## 5. 流程、退出与恢复

1. 顺序入口：本地 intro 播完起算 5 秒；未唤醒则提醒一次，提醒播完再等 10 秒，仍未唤醒则退出、不标完成。失败/缺失音频 20 秒内放行，不挡正常游戏。
2. 提前唤醒：原页面冻结；真实输入已就绪后仅发 begin(entry=early_wake)，不再重做本地唤醒练习、不重启房间、不吞孩子首句。
3. 服务端选择缺失问题，播完进入 waiting_answer。孩子真实语音活动延长静默预算；ASR final 只表示输入活动，不能等价于记忆保存。
4. 单题播完 5 秒无输入：客户端只请求一次 request_exit_prompt，服务端使用 quiet_exit，不循环追问；退出提示播完等 10 秒自动结束。
5. 正常完成：服务端使用 complete_exit，随后 waiting_exit；“退下/不聊了”由现有语音退出识别，任何阶段可结束。继续回答时取消退出倒计时，由服务器决定补问或 normal_chat；normal_chat 只结束教学，不关普通语音房间。
6. 资料保存失败返回 failed，不伪报 saved；界面恢复原欢迎/礼包/演出/生态缸阶段。游戏暂停理由独立，不清掉待机、霍尔、OTA 或设置自己的暂停。
7. 本地尝试日通过 Runtime 原子持久化，采用全档单调游戏日；同一真实 trace 仅入场一次，自动教学等待其他导航教学结束、新的真实唤醒仍可打断；不成功则同日不反复主动提示，下一游戏日补触发；GM 清游戏档后可重跑。提前真实唤醒仍可练习，完成后不再重复主动教学。

## 6. 请服务端回执确认

- 是否接受上面的能力字段、control type/lane、stage、幂等及租约数字；确认后冻结，任何差异先书面列出，不原地漂移。
- memory_write=saved 的真实落库时点、年龄/生日精度、绑定孩子选择与多端并发条件写规则。
- 是否使用七句本地音频选择机制（推荐）；若远端播音，要保证不双播、waiting 状态不抢跑、现有 TTS/ASR trace 可对账。
- 已知资料全跳过、部分缺失、全部缺失、拒绝、无回答、保存失败、恢复后正常聊天、倾听模式互斥的测试窗口与证据。

## 7. 验收边界

客户端 GM 显式“本地模拟”只验证前端流程、预制语音、超时恢复和视觉。日志必须有 mode=simulation/no_cloud=true/no_profile_write=true；不造 ASR final、不发真实 server 控制、不消耗真实教学尝试/完成标记，不写孩子云记忆。
真实 ASR、可信当前 worker 控制交付和服务器记忆落库，需要服务器按同轮 trace/request_id 独立回执后才可关闭联合待办。
