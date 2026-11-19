# 语音教学v2：服务端实现合同（候选，未上线）

业务以CLIENT-CHANGE.md为准。客户端固定年龄→性别→昵称，不按云端已有字段跳题；静默、识别失败、记忆失败都可以继续。仅端侧4A/4B实际播完记录教学完成，3C退出不算完成；服务端不存教学完成位、不播任何教学语音。

## 协商和发布

复用POST /v1/device/session；新包只声明supports=["voice_onboarding_v2"]。原总闸、原设备名单、普通池、非倾听、精确Worker agent检查不变；增加默认关闭VOICE_ONBOARDING_V2_ENABLED=1作为版本发布门。先部署兼容Worker，再部署Brain，最后开版本门；禁止旧Worker收到v2签票。若同时支持v1/v2，版本门打开优先v2，否则仅明确声明v1者走v1。旧v398维持v1语义。

响应voice_onboarding_contract={version:2,capability:"voice_onboarding_v2"}；签名Worker metadata voice_onboarding.version也为2。没有v2合同的新客户端必须本地完成有界教学，并关闭答题音频进入普通聊天的通路；服务端不能替未建立的Runtime保证隔离，也不虚报保存成功。

## RTC控制

沿用topic=control，type=voice_onboarding.request/voice_onboarding.state，lane=voice_onboarding；可信Android participant，outer trace与payload trace都必须与签票一致。

```json
{"trace_id":"trace","ts_ms":100,"src":"android","type":"voice_onboarding.request","lane":"voice_onboarding","seq":3,"payload":{"v":2,"trace_id":"trace","session_id":"session","lesson_id":"lesson","request_id":"audio-1","question_index":1,"revision":2,"action":"audio_complete"}}
```

所有payload字段如上；标识仅字母数字_-，1..128字符；question_index=0..3；revision=0..1000000。客户端维护单课revision：begin=0且question_index=0；每个新动作递增；重发同字节、同request_id、同revision，每3秒最多3次。下行seq为独立递增传输序号，不用payload revision去掉同一题的answer_result。

|动作|规则|
|---|---|
|begin|立即进入隔离；已在播放的普通回答停止，不等待旧版9秒延迟|
|question_started|严格1→2→3；未答或超时可由客户端继续下一题，无云端选题/重问|
|audio_complete|只对当前speaking题开回答窗；可选audio_status=complete；failed等同该题跳过|
|question_skipped|关闭当前题；撤销未提交答案任务，不重复写资料|
|finish|端侧4A/4B播完后释放隔离；服务端不证明端侧完成位|
|cancel|用户退出/关房/系统中断，不算完成|

可选entry=scheduled/early_wake/next_day保留兼容，但不影响题序。未知字段（含simulation）拒绝；GM模拟不发真实协议。超过180秒只报expired，不伪装finished。超时后保持安静直到端侧finish/cancel或正常关房；单题失败也不释放普通聊天。finish/cancel可在begin前封闭课，防延迟begin复活。

## 回执与存储

控制动作直接返回action=ack、result=ack/finished/cancelled/expired、memory_write=none。ack只证明Worker已处理控制，不承诺Brain落库。

```json
{"v":2,"trace_id":"trace","session_id":"session","lesson_id":"lesson","request_id":"audio-1","question_index":1,"revision":2,"action":"answer_result","result":"accepted","memory_write":"saved"}
```

answer_result沿用打开本题的audio_complete request_id；内部Brain答案请求用独立幂等ID，不暴露到客户端。result=accepted/unrecognized/declined/failed；memory_write=none/saved/skipped/failed，两者独立。accepted+skipped表示已有权威资料、不覆盖；accepted+failed表示识别有效但写入失败；网络超时只能failed+none（提交结果未知），不能伪造已保存或断言已回滚。

只用原本地确定性资料提取器，不逐句增加LLM。年龄只保存整数age_years/age_observed_at，不推算生日；性别/昵称只写绑定孩子行；家长行只读。保留v1已有资料规则：孩子或家长存在该字段时，不覆盖，仍接受本题并报skipped。多孩子/绑定变更拒绝，不猜账号。只在实际事务提交且更新一行后saved。

内部HTTP POST /v1/internal/voice-onboarding/v2/step，原Worker JWT+grant双验证，4KiB上限；v1 /step语义原样保留。v2内部控制动作与RTC同名，另有Worker专用answer含text≤120字符。控制按顺序异步串行，队列最多16；音频循环不await HTTP，每次HTTP1.8秒。跳题撤销排队/在途旧答案，finish/cancel优先发终止栅栏。

服务端先收到并提交skip/close后，迟到旧题写入被拒绝；如果答案已先提交，不倒删事实。过时HTTP回执丢弃，不推进端侧。ASR目前只有文本final，没有供应商utterance-id绑定question，因此服务端用播完后的新VAD及当前题类型门禁；不能把这写成所有声学迟到场景已通过。真实ASR/AEC和按题切换需新APK同trace联调。

## 与Grok初审建议的裁决

review/01-freeze.md是建议，不是最终接口：保留result/memory_write字段，与既有服务端命名一致；新增独立/v2/step隔离协议；保留默认关闭版本门便于Worker先行发布。采用audio_complete RID关联、严格三题、保存和识别分离、过期不完成、失败不掉聊天。

不采纳review/03-acceptance.md中B5“覆盖已有昵称”及G1“覆盖已有生日对应年龄”的建议，与附件“已有资料沿用记忆规则”和同报告保护既有事实的描述矛盾。当前一律保留已知资料，accepted+skipped明确告知。家长行有资料时不冒写孩子事实。

## 回滚

源码回退点rollback/p003-voice-onboarding-v2-pre-20261117=81cbd0b10be15037f8f3fe0ea4846eb6bac6236b。本轮未上线、未改开关、未访问真实画像。未来配置先关闭v2版本门；已拿v2租约的房间≤180秒继续兼容处理，排空后回旧Worker。新增protocol_version/question_state列保留，旧代码忽略；不回灌数据库、不删除真实画像、不清绑定。

追加自检：若房间协商了ordered首句，真实v2 begin借用既有phase switch立即转连续RTC，清退旧首句缓存，不回灌本地提示回声；仅教学begin触发，普通房间首句机制不变。客户端按既有session.input_phase处理rtc，reason=voice_onboarding_v2。不再等待begin_timeout才开始接收教学答案。
