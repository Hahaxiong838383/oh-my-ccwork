# 38：v384正式Worker发布后最终只读复核

**结论：正式Worker与Brain配对发布、真实admin就绪和超过3分钟的采样稳定性核验通过。旧70d仅保留为历史；当前实际运行5b3fdaac正式产物。未创建真实设备会话，未改生产，不将此结论扩展为真机语音体验通过。**

## 版本与进程

- 当前实际/proc/2750511/exe SHA：`7d39184c200053db5adbc59580517110762b0c3ac31928cc246d5f9162817de0`，77972432字节；release build `5b3fdaac2b0e6d552a899ea7a941616cfbed2d5d`。不是39隔离feature binary270df2ab，亦不是旧70d binary27a72325。
- Worker PID2750511/NRestarts0/active，观察首尾实际binary及release哈希相同；release.json SHA `58c0dd5d15450b3b26e4c5a0bdda833cf7b1801454cdcd2eb0535ef425b6717b`。
- 主Brain核准manifest SHA `c6013b898ddc292fd3b2f17c27260cefbcbb2ca4dda75090b6dabbd02663618b`，核准同一build/原capability，与activate-worker-manifest-result.json相同。真实ACK与applied_revision说明现役进程接受了新配对。
- main PID4186397/restarts51，listening Brain4186369/NRestarts0；search Brain3839441/NRestarts0、analytics3937833/restarts9均保持。三个Brain health HTTP200/status ok。

## 精确Brain四文件

| 现役路径 | SHA256 |
|---|---|
| `/opt/p003/server/src/ark/answer.ts` | `801c005c4d3435aa95b7d7ab17d10b87f3cef41bb7063005d81590bc9df81c56` |
| `/opt/p003/server/src/routes/custom-llm.ts` | `ce416f6c86ce429d1132970aa57b378648ffa04d164895f1b52fe67205c73c4d` |
| `/opt/p003/listening-canary-20261030/brain/src/ark/answer.ts` | `801c005c4d3435aa95b7d7ab17d10b87f3cef41bb7063005d81590bc9df81c56` |
| `/opt/p003/listening-canary-20261030/brain/src/routes/custom-llm.ts` | `60a2047295becdc502ae6b8bbbc9727750d4dd39429d55ab0bb1ddfc8c70e477` |

以上四文件在观察前后都与部署回执及18:09旧Worker阶段的Brain快照相同。search custom-llm.ts仍c668eccd…，未把搜索树整体覆盖。

## 稳定观察与实际HTTP

- admin：18:20:07.276 CST—18:23:22.303 CST，14次，每约15秒一次，跨度195.027秒；另补末次两次HTTP读取至18:24:20.484 CST。
- Worker：18:20:47.717 CST—18:24:03.118 CST，14次，跨度195.401秒。
- 所有实际admin HTTP200/ok=true、runtime=evidence_ready、ready=true、effective_enabled=true、applied_revision=6；各周期ACK递增。稳定段最大ACK年龄3201ms，含末次补采样最大4802ms，均小于5秒。
- Worker所有采样registered=true、cleanup healthy、pending/remaining=0，health最大年龄4627ms；PID与NRestarts保持。active_sessions和jobs均为0，本次是空闲注册稳定观察。
- 采样期间未见异常；15秒采样不能排除采样间瞬态，更不替代负载或真人场景测试。脚本直接import deploy_remote.run(timeout=260)，完整捕获195秒结果，没有触发CLI默认180秒超时，也未重复启动稳定采样。

## 窗口、服务凭据与保护池

真实配置仍enabled=true、revision6、仅尾03800006，sourceGeneration1，业务generation v374-listening-ark-20261102-1793613511不变。主库、倾听独立库、两端expiry state、Worker window、Brain manifest截止均1794391200000（11月11日18:00 CST）；双timer实际active/waiting，Brain18:00 CST与Worker10:00 UTC对应同一时刻。timer/service/expiry脚本SHA与延窗后快照相同。v374-window.json中的enabled=false是既有expiry恢复状态，不是当前有效开关；实际Worker window和Brain配置均为enabled。

实际PID2750511进程内服务JWT唯一，exp1794391200/未过期，凭据有效期与窗口相等；仅输出时间claims，未导出token或声称payload解码就是验签。真实admin ACK证明现役Brain已接受服务认证/配置应用证据。

普通voice-worker-rust PID2445772、search-worker PID2446060的binary/env/window指纹与39发布前清理快照逐字段相同；正式listening env/window也未变，仅binary/release变为本次产物。Brain侧search与analytics PID/重启计数及已核搜索源码保持。未读取原始用户语音、未签设备票或伪造ready。

## 发布后journal安全计数

| 单元 | 起点 | 至18:24:40左右记录数 | panic | ERROR/priority≤3 |
|---|---|---:|---:|---:|
| p003-listening-brain | 17:58:31 Brain发布起 | 9 | 0 | 0 |
| p003-listening-worker | 18:18:25 Worker发布起 | 701 | 0 | 0 |

按journal JSON逐条在远端统计，只导出数量和固定类别，无正文。未把该结果扩展为PM2 main应用日志全量无错；main本轮核健康、进程和源码。

## 证据、恢复与下一步

安全JSON：evidence-38/formal-deployment-verification.json，包含上述原始安全快照SHA与机械断言；可复跑`python3 evidence-38/verify-formal-deployment.py`。采样脚本、两端journal计数脚本均0600；原树保持clean，无源码提交。

主13部署回执记录恢复点：Worker `/opt/p003-listening-canary-20261030/backups/v384-worker-20261104`；Brain manifest `/opt/p003/listening-canary-20261030/backups/v384-worker-manifest-20261104`；Brain四文件 `/opt/p003/backups/v384-voice-brain-20261104`。本轮未演练回滚或独立复读这些备份内容，不将目录名当作回滚演练证据；若需恢复由13按配对版本执行，勿恢复已过期服务JWT。

下一步由13收口发布并交安卓：以新签票真实会话复测H1补勤卡答案、短退出后同房继续聊天；语音进入、真人唱歌及反馈期间退出按实际证据补验。本轮不新建设备会话、不重复既有RTC。

署名：codex（OpenAI）｜2026-11-04 18:26 CST
