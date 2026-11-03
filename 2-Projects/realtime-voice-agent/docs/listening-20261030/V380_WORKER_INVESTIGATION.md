# P003 v380 Worker 联调与发布交接（2026-11-03）

结论：**两词 ASR 增强可交主13发布；倾听退出兼容链在六项隔离 RTC 场景通过，本轮没有证据需要修改现役 Worker 业务代码。主13在18:53尝试后台发布触发sidecar保护，已自动回滚，候选尚未上线。原口述“云端退出、端侧未收到”的真机故障尚未定位，不能宣称已修复或真机全验。**

实现候选 `d36248a65b9271217ae0bc094ae1ed30e93a809f`；原分支 `codex/p003-listening-worker-20261030`，任务前回滚点 `fc1234deca51e71a021815b08c5b88b339886f20`。本轮两个实现提交只改测试、探针及离线快照工具；Rust 变动全部位于 `#[cfg(test)]`，生产代码前缀逐字节相同。三合同未变。后续文档提交不改变测试输入。

## 现役与故障范围

- 倾听生产源继续为 `70d5f98a8f4d3e4aceca00890271a7bd7a1b6f3d`，PID2386175，binary SHA `27a72325f781e37d1114f91b58feb53bfd38de4b1e6ec2ca6453a7745bcd5e86`。不因为测试工具提交重建/替换该二进制或修改 build manifest。
- 17:49–17:53 的11组 trace/room 与38、45索引交叉一致，设备末8位03800006；这些是正常唤醒/Ready/空闲退出，附件未提供故障那一次 trace/音频。缺少日志不能推断未发包，更不能定位为同一个异常。
- v380 原源码 `6558e03ee9fda9f77d8a1f6209eae49124a55526`：正常退出消费原 proposal→Android自己分配seq/request→completed normal，房间保留。异常 fail-closed 则原有 job 收尾关房，通过标准 Room Disconnected 触发端侧 reset；不伪造旧ACK、normal成功、告别事件或新增terminal协议。
- v380不接受“已完成enter”的旧seq作为异步终态；本轮按真实合同验证。share/sharing、failed/rejected、feedback状态枚举差异仍列为旁项，不通过修改全局wire掩盖。

## 本轮实测

| 项目 | 本轮证据及边界 |
|---|---|
| 本机 Python | 13项通过；consumer漏localReadySent先红后绿；隔离root仅放行精确session39测试目录，拒绝生产目录 |
| Linux Cargo | 最终90输入核SHA，611通过（566+29+9+7）、3默认ignored；没有沿用旧536/517数字 |
| 实际 ASR context | 4次独立进程校验，Rust实际env合并/build_init_payload与真正探针函数在UID归一、context解码后逐字段相同 |
| Rust→Brain HTTP | 显式2项通过，复用bundle前重新核33项Brain源码SHA；bundle `1b160da86a0725423729960cfe4e492cc7c4ce7652a31c4bf1bca12dbec6ae73` |
| 六项真实 RTC | normal、missing_ready、lease_timeout、revoke、barge、proposal_timeout全部通过；每项房间均由API证实不存在 |
| 独立消费端 | 38固定SHA脚本复审13项；精确原v380 Kotlin控制器定向14项，并回放本轮RTC实际下行、比对原seq/request上行，六项全部回放通过，证据输入SHA已核 |

RTC是实际 SFU、独立 Worker job/Orchestrator、隔离 Brain SQLite/注册/授权路由、真实 ASR/TTS和连续合成音上行；**文本模型为确定性替身、Android为软件客户端，JVM回放不是手机UI/真人声学验证**。Brain fixture冻源eeac0a68，与线上BLE凭据绑定门差异单列于38证据，不能冒充可部署Brain。隔离EOT_SOCK无sidecar且未配置自动启动，日志确认EOT不可用降级；没有测试真实生产端点模型。

RTC复用70d5测试特性binary `1fda3c073fbc7a110186d36fabbeb45fe33838780eabd5fbfa9e85d114b6ea1a`，不部署生产。normal验证首句进入+立即续讲（后续反馈实际包含合成故事标记）、普通叙述静默、反馈一次、exit恢复普通音频/字幕/metrics；barge从上行开始到最后音频1167.302ms，之后无续播，不能夸称即时打断。缺local_ready及提议超时、停隔离authority导致租约过期、后台撤权均实际收到服务端断房reason5，消费端reset。撤权到实收断开约12.25秒，保留有界失效语义。proposal_timeout是软件探针故意不发送enter；原Android会生成该命令，JVM明确将其建模为传输丢失，不称Android自然忽略提议。

首批revoke因探针旧目录断言失败，补精确白名单后重跑通过；失败记录保留。初版Rust测试JSON宏编译失败后修正并完成最终Cargo；这些都不是生产Bug。max-duration真实RTC、广泛丢包/乱序故障注入、真实手机UI及真人唱歌本轮未重验；旧测试不算新RTC证据。

## 补勤卡 ASR 效果与限制

权威词为**补勤卡**，合法同义词**补签卡**。后台published asr原id2/v1共27词，device_asr id10/v2共247词；两者与运行环境原值一致，但没有这两个词。现役后台发布只更新普通池，不会刷新独立search/listening canary.env。

仅把两个正确词前置到asr（27→29）；device_asr247词、ASR模式/路由/设备范围不变。普通池当前二遍开启，搜索/倾听一遍。本轮两种模式均对照，不为结果改模式。

| 同一14句合成PCM中的目标词 | 原词表 | 两词前置 |
|---|---:|---:|
| 一遍9个道具词位置 | 1/9 | 9/9 |
| 二遍9个道具词位置，首轮 | 3/9 | 8/9 |
| 二遍同PCM重复 | 3/9 | 8/9 |
| 前7句核心道具词，一遍/二遍 | 1/7、3/7 | 7/7、7/7 |

这是**目标词命中，不是整句正确率、库存问答或真人成功率**。一遍“我有几张”仍可能成“忽悠几声”，语义不能据此认定库存查询通过。二遍“故事里的补勤卡”两轮仍为“补情卡”；“今天不请客”首轮候选漏句，重复恢复正常。5个近音负例未新增道具词误触；额外“小可/今天天气怎么样/暂停”一遍AB同文。没有用户原声；合成来自现有授权TTS供应商。

PCM SHA `61382316315398e8cddd098898cbae9e289a5ebc901a20a30bc2be91fac8a7f8`。实际合并请求274→276词、目标位于0/1；只证明发送顺序、字段及此次识别改善，**厂商流式100token等内部预算不透明，不能称276词全部有效**。

## 主13发布与回滚

以下为原发布预案，18:53回滚后本轮draft id11仍保留；重试须先核其内容与本轮批准两词一致，不能盲目清草稿或force。

1. 初次发布前复核后台asr仍id2/v1、旧CSV SHA `a3393758419d51db148f87be9f9fb53fcaad479ccce88817de3ae83d78c7aab7`、无草稿、live一致。只走现有PUT draft与publish `kinds=[asr],force=false`；精确请求与原27词回滚body见证据JSON。**普通池发布是全设备词表更新，不是仅038**；不扩大倾听/搜索设备范围。
2. 普通池成功发布后重新GET `/api/admin/hotwords`。对每个canary私有旧env计算完整SHA，运行 `rust-worker/scripts/listening/prepare_hotword_snapshot.py`：`--snapshot <发布后JSON> --env-file <私有旧env> --expected-env-sha <完整SHA> --output <新0600文件> --receipt <新JSON>`。脚本仅生成新文件；拒绝并发草稿、旧env漂移、额外词/设备词变化；原文件及其他键原字节保留。脚本SHA `8736dd5f6437ef191af73b3c25983727908fec5482402bf4fb09a2708c2a4a6a`。
3. 独立池路径：`/opt/p003-listening-canary-20261030/canary.env`、`/opt/p003-search-canary-20261021/canary.env`。由13备份、确认各池无活跃job，再逐池原子替换/重启并核进程值；词表发布不会自动触及这两个路径。不要输出或提交env正文。binary/window/release/路由/ASR模式不改；观察三分钟无重启风暴。部署是13职责，本39没有执行。
4. 回滚走后台旧27词草稿→仅asr重新发布；随后按池恢复这次私有原字节env备份并核published/进程值一致。普通池回滚不等于独立池已回滚。禁止整库恢复或覆盖旧分支。测试源码若需撤销，只撤本轮48f368ad/d36248a6相关变更，保留70d5生命周期/入口修复。

18:51:43 CST清场证据：7个测试房API均不存在，独立Worker/collector/Brain及3个ASR进程全部结束；生产三池PID/二进制/NRestarts与开始一致，倾听env/window/release完整SHA不变。这只是18:51时点；18:53主13发布502后自动回滚，普通池已重启为PID2443912，原asr id2/v1/live27恢复，其他kind与canary未变。18:55只读逐PID核EOT仅生产普通/搜索/倾听三个服务cgroup（2443921/2143118/2386177），无本轮测试EOT残留；现役apply_hotwords.py的sidecar_count全机匹配，包含其他池，已交13定位，不泛kill、不绕过保护。39未操作生产，不能据此说全局没有发布尝试。全套证据在协调目录`evidence-39`；SHA索引随本仓JSON归档。39不更改共享记忆和其他工作树，最终Air交付由13统一。

## 给安卓的最小复验

等13发布回执后，由设备持有人主动测试，39不唤醒真机：

- “小可，先听我讲个故事”，紧接叙述、自然停顿；应继续倾听、不普通回复。
- “小可，我讲完了，请说说你的看法”，应只反馈一次；插话后不补播旧音。
- “小可，结束倾听，恢复聊天”，应退出倾听而保持聊天；再问普通问题有回复。
- “补勤卡有什么用”“我有几张补勤卡”“我还有多少补签卡”，分别核ASR原转写、KB用途、真实账号库存，不把错转写或null改0作为通过。
- 若再现UI停在倾听但云端结束，提供精确北京时间/时区、SN末8位、trace/session/room、最后proposal/ACK的seq/request/stage/state、Disconnected事件及本地reset/UI时点；不提供token或用户原文。缺trace不能将正常空闲退出记录代替故障样本。

署名：codex（OpenAI）| 2026-11-03
