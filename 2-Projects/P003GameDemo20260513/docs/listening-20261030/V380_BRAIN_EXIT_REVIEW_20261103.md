# v380 倾听退出：Brain权威及客户端消费核验

结果：已完成当前Brain只读取证、精确v380源码核对、14项JVM测试；6组真实RTC消息回放和39固定候选独立复核已完成；尚不能把用户口述异常定位到某个trace。未发现需要修改Brain业务的证据。本轮不改业务源码、三个冻结合同、生产配置或设备范围；主13统一处理生产发布。

原分支 `codex/p003-listening-brain-20261030`，源码回滚锚 `32d55ceb4e9c4ce907c3e9599e02281f41c25d41`；本轮新增离线核验材料，不是线上回滚包。私有证据目录 `/Users/fu-121/.local/state/p003-v380-coordination-20261103/`。原附件SHA `6c0b322b1419f5389935723df1f1532e619f2b2f8dfc88ad19983fca955fcc38`。

## 现役权威与历史边界

18:22–18:24 CST只读查询SQLite及当前管理接口：配置rev6、仅03800006、story/sharing/singing、voice invitation启用；15秒lease、5秒刷新、1秒请求预算。runtime ready/applied6/active0只是查询时刻快照。release manifest SHA `608eeea328f129acaf7a46b78f1005a192a7c10db2fcbacb6470fbd5dcbd5765`，登记构建70d5f98a，原截止11/4 17:58:31未变。

- 17:49:18.757–17:52:46.015恰有11次尾038成功签票，trace/room SHA与39独立Worker日志逐条一致，登记包含语音控制能力，build70d5f98a。对应保留的entry/request/closed/revocation均0。
- 客户端附件只记11次模拟唤醒、Ready、正常空闲退出，未提供问题SN/trace或倾听异常事件；因此时间与次数吻合不等于定位了用户反馈的那次故障，也不证明首轮拒绝的异常路径已真机通过。
- 追加当日00:00至18:36:33、仅已确认SN摘要匹配的元数据索引：168签票行（84 ok、83 prefetch、1 rejected_429），早于17:49的ok有68条；仅5条authority仍保留，相关倾听表0行。`register()`清理过期session并级联删除entries/requests/closed/revocations；lease字段也不是事件日志。**不能拿当前空表证明当天从未进入或退出倾听。** 早期trace/房间SHA索引已交39，只用于定向历史日志查询，不外发用户正文。

Brain的close是鉴权后的幂等元数据关闭，不直接向RTC发送终态。lease/content遇权限、设备绑定、ready、截止失效会拒绝/撤销；Worker负责使音频和RTC状态收敛。当前主Brain authority比本树多已上线BLE `acceptsDeviceBindingCredential`检查，禁止整树覆盖。短信、BLE、微信、Ark、搜索等现役差分不属于本轮回退对象。

## 精确Android合同与实际复现

Android来源 `6558e03ee9fda9f77d8a1f6209eae49124a55526`，12文件冻结manifest SHA `f72e5195c825936f7f33372642a9342332ef4f7457ad05b96226bf7a73bb77be`。从主13精确裸仓提取，未替换客户端包。

| 路径 | v380实际消费行为 | 本轮判定 |
|---|---|---|
| 正常倾听exit | `control/listening.proposal action=exit`；Android分配seq/request_id；匹配pending的`completed normal`恢复NORMAL，保留RTC | 沿既有合同，不能换成结束整个会话 |
| 无pending的ACK | 已完成enter后pending为空；旧request_id/seq的异步ACK被忽略 | JVM实际复现；不能伪造旧ACK通知退出 |
| 状态查询 | 仅pending握手3秒/5秒查询、6秒失败恢复；进入成功后没有周期查询 | JVM推进60秒未产生额外query；不能指望自动发现server Paused |
| 异常终态 | 标准RTC Disconnected进入外层stop→controller.reset；Paused保持fail-closed | 主13已裁定沿既有断房链；不是新terminal消息 |
| 普通session退出 | `session_exit_detected`消费自身seq、播放本地告别、结束整个会话 | 不用于冒充倾听故障/用户退出意图 |
| `rejected`/`failed` | Worker rejected被v380当未知stage；failed即时恢复；rejected可随后6秒超时恢复 | JVM复现历史差异，不归因本次story异常、不擅改wire |
| `sharing`/`share` | v380只接受share，服务端用sharing | JVM复现，旁项交主13/安卓；story不受该字段差异直接影响 |
| `feedback_active` | 查询响应会被v380判state_invalid；仅识别feedback | JVM复现，记录兼容缺口，不把它写成历史故障根因 |

可信消息仍需当前room/trace、服务端AGENT kind、`lk.agent.name == expected_agent_name`，锁定实际identity/SID。`expected_agent_name`来自签票响应顶层；调度名不能直接与`agent-<job_id>`相比。`listening.proposal/ack`均经过这条门。进入倾听时空闲watchdog会暂停，所以异常测试必须核对对端真正断开和清理，不能仅看server state。

## 本轮实测与复跑

使用既有Adoptium JDK17与Gradle缓存；未安装依赖。精确原控制器、codec、原8项测试均按SHA校验后编译；新增6项针对上述消费差异及local_ready门槛，14项通过。新增的是复现/边界核验，**不是声称修好了Android**。

```sh
python3 docs/listening-20261030/evidence/v380-20261103/run_jvm.py \
  --client-src /Users/fu-121/.local/state/p003-v380-coordination-20261103/evidence-38/client-source/android_injection/livekit_sdk_probe/payload/src \
  --out /private/tmp/p003-v380-jvm-review \
  --java /Users/fu-121/mycc/2-Projects/kidshub-ai---godot/.tools/jdk-17-adoptium-20260822/Contents/Home/bin/java
```

命令从项目根执行。脚本只读输入和已有jar，构建输出写指定临时目录。可追加`--replay <39的scenario-result.json>`，按原接收顺序将真实下行包交给未修改控制器，核本端生成的seq/request/payload与实际上行对应。探针额外查询只预留其序号，**不把这些测试注入当Android原生行为**；不改下行ACK字段。仅场景完成前的服务端断开计入，排除测试清理主动断开。离线回放不验证RTC可信属性执行、实时计时器、麦克风、扬声器或Android页面。

隔离Brain复用既有bundle SHA `952e58ac01c278836ee7466f771cf0bc10469dbddb2bc0c344c4e22f7424848a`、manifest `84e01a52c929b806d1d991fdfb67ff621edeecde5600258bc714a24acfd7263c`；65源码输入重新逐字核同。真实路由/authority/registry/config ACK，合成身份、测试库、确定性文本provider；39独占RTC启动/清理。本包缺现役BLE guard等差分，明确仅是隔离验证输入，不能部署覆盖现役。

45的补勤卡/补签卡用途与unknown/GM边界另作只读交叉核对：9个现役文件重算SHA并与856552b9精确Git内容核同；不扩别名、不修改钱包/快照。它不等于ASR效果通过。

## 真实RTC消息独立回放与固定候选复核

39固定验收脚本候选`48f368ad58910867cc5b1f3d13f4a8c054c0e504`：独立提取6脚本并重跑11项通过。另加独立负例实际失败：简化consumer在未received/local_ready时会接受completed listening，原v380控制器则要求localReadySent。39在`d36248a65b9271217ae0bc094ae1ed30e93a809f`最小修正模型标志/调用、精确隔离root以及Rust测试宏，未改业务/wire。独立提取修正后6脚本并跑13项通过；原负例再跑通过。revoke首批因旧隔离目录assert失败，原始失败保留；补跑成功。补跑probe/consumer SHA与d36248a6精确一致。

六个已完成场景的真实下行ACK保持原字节字段，交精确Kotlin控制器消费；控制器生成的上行seq/request_id/payload逐项匹配实际记录，结果均通过：

| 场景 | 对端事件与实际消费 | 限制 |
|---|---|---|
| normal | LISTENING→PREPARING→NORMAL；exit_completed确实消费；场景内未断房，之后普通聊天有音频/字幕/metrics | 合成语音、确定性文本provider、软件客户端 |
| missing_ready | 未完成进入；received后5210ms服务端断开reason5，reset后active=false，零出音 | 测试故意丢弃local_ready传输；不是Android本地音频未就绪实测 |
| lease_timeout | 已进入；停隔离authority后12247ms服务端断开reason5，reset后active=false，零出音 | 仅隔离Brain SIGSTOP；生产未停 |
| revoke | 隔离配置撤权后12245ms服务端断开reason5，reset后active=false，零出音 | 仅测试库rev3关闭、rev4恢复；不等于生产开关测试 |
| barge | 合成RTP打断后1167.302ms内停止出音且未恢复旧音频，随后exit_completed→NORMAL并可聊天 | 不等于真机扬声器/回声环境验收 |
| proposal_timeout | 测试故意不发送enter；proposal后3341ms服务端断开reason5，零出音；原控制器收到proposal后会生成enter，回放把它标作传输丢弃，断开reset | 此故障注入不代表Android会忽略有效proposal；未冒称自然客户端行为 |

退出成功依据已剔除场景结束后的客户端清理断开。真实RTC进程、签票、sender kind4/name/identity/SID、trace一致已核；首批probe/consumer SHA与48f368ad一致，补跑与d36248a6一致。被测业务源为现役70d5f98a，test-feature产物SHA `1fda3c073fbc7a110186d36fabbeb45fe33838780eabd5fbfa9e85d114b6ea1a`，不同于生产二进制；没有因此要求重新部署或改build manifest。

证据：私有`evidence-38/rtc-first/independent-observations.json`、`jvm-final/rtc-replay-results.json`及`jvm-delivery/result.json`。本树`evidence/v380-20261103/review-results.json`固化源/输入/日志SHA。回放仅按事件顺序，未推进录制时间，也不覆盖Android外层stop的完整UI/音频资源；只验证原控制器消费和reset行为，不替代真机。

## 待补证与回滚

39最终Linux日志独立核读：611通过、3默认ignored；另显式4次context测试通过，2次真实Rust→隔离Brain HTTP测试通过。90个Linux输入与d36248a6精确Git字节一致，33个HTTP Brain输入与本树重新核同；这是对39执行证据的独立核验，非38重跑Cargo。没有因工具提交要求替换现役70d5二进制/manifest。

主13要求的发布脚本只读复核亦完成：发现“stop已成功但drain检查失败，标志未置位导致未恢复”的确定异常分支；13修订为stop_attempted/实际状态恢复与人工恢复标记，固定helper SHA/commit，后台异常finally记录并只读reconcile。38独立执行5项AST隔离恢复用例通过，未调用生产systemctl。每单元部分发布/回滚状态仍须以13实际执行回执为准。

真实Android UI、真人语音与用户口述故障的唯一trace仍需真机复测，不能用合成语音或MacTTS替代。安卓建议最小复验：故事进入后正常退出可继续聊天；模拟允许范围内的断连后退出倾听提示并能重新唤醒；保存实际trace/时间/版本，禁止故障测试扩到其他设备。历史share/sharing、failed/rejected、feedback_active旁项交安卓做后续兼容评估，不擅改当前冻结wire。

39独占隔离资源清场，主13独立确认jobs/房间/进程及生产漂移后决定发布。38不会以文档或回放代替这一步。

本树无生产业务改动，无服务重启或开关变化。回退只需撤销本轮新增核验材料的提交，不能reset整树/回灌数据库。生产回滚必须由主13按实时备份和逐文件差分执行。

署名：codex（OpenAI）| 2026-11-03
