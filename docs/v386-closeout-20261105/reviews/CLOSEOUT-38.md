# v386：38 Brain权威与三条实机trace收口

**结论：Brain独立取证确认三条实机trace的身份、签票选择、历史授权、租约与成功close均闭合，可关闭本轮Brain权威侧待验。结合客户端v386回执，可以支持三短口令退出及UI残留/PREPARING空闲竞态的限定收口；RTC完成ACK/同房后续回答由39交叉核验，Android UI时序属于客户端回执证据。一次session超时保留独立观察，不能把全部语音可靠性标为关闭。**

## 三轮历史闭环（北京时间2026-11-05）

| 客户端退出口令 | 完整trace | 签票时间 / 服务端记账耗时 | story seq | 首次租约记录 | 成功close |
|---|---|---|---:|---|---|
| 结束倾听恢复聊天 | `b04ef593-f44c-4b69-bb45-4c4d96b09c8b` | 16:04:07.869 / 9ms | 46 | 16:04:14.497 | 16:04:27.676 `close-6` |
| 恢复聊天 | `eab501f1-16c5-49b3-a459-8eaeabfbe6e2` | 16:06:24.650 / 11ms | 61 | 16:06:31.182 | 16:06:37.385 `close-4` |
| 小可结束倾听 | `e843d07a-ee82-4b07-9b15-9fcf4ef62cc8` | 16:11:28.534 / 11ms | 98 | 16:11:34.791 | 16:11:41.592 `close-5` |

- 三trace各唯一对应一条session log、一条listening_sessions权威记录和一条entry；库内完整SN及账号哈希相等，可信SN均尾03800006。完整session与脱敏room见EVIDENCE-38.json/TRACE-MAP-38.json，没有按后缀猜身份。
- 历史authority均为正式Worker `5b3fdaac2b0e6d552a899ea7a941616cfbed2d5d`、agent `p003-search-listening-20261030`、sourceGeneration1、voice_control_v1；entry snapshot均revision6，SHA `9ceff0d0e71c8e26ed66caa0c01ca57d724f2d0e4c6f7ac57c981574359f832f`。历史权威截止为1794391200000，未拿当前ready替代历史证据。
- 三轮历史device-session日志均selected/registered=true，有效派单租约余量10617/8840/9953ms，jobs0/max2，generation一致；关联到同轮prefetch。签票记账9/11/11ms是服务端该阶段耗时，不是端侧总体连接延迟，也不是Worker实际接单完成时间。
- 每轮首条lease返回authorized=false/expiry0，随后分别4/2/3条authorized=true。已核**现役**authority SHA `c401b6b5…` 的125–144行：先回配置快照，应用snapshot后才授权；首条false是配置应用交接，不是鉴权拒绝。本树旧authority SHA不同，未拿旧树当线上执行源码。
- 三轮close均status=done、reply.closed=true；close发生于最近有效lease及grant覆盖内；entry.closed=1、lease_until_ms=0，无revocation。Brain close只证明授权关闭完成，不能单独推出Android已消费RTC ACK或UI已切换。CPU/音频/RTC退出由39与客户端证据补齐。

## 当前只读配置与版本（16:44–16:45 CST快照）

- enabled=true、仅03800006、revision6/sourceGeneration1；主库与倾听独立库截止仍1794391200000，即2026-11-11 18:00 CST；未延窗、扩名单或重新开闸。
- 主Brain核准manifest SHA `c6013b898ddc292fd3b2f17c27260cefbcbb2ca4dda75090b6dabbd02663618b`，仍对应5b3fdaac；expiry timer实际active/waiting于11月11日18:00 CST执行。manifest不冒充Worker实际/proc二进制验真，Worker现场由39负责。
- main+listening的answer.ts/custom-llm.ts四文件SHA均与11月4日发布回执逐字节一致：answer两份801c005c…；main custom ce416f6c…；listening custom60a20472…。只对这四文件作一致结论，不宣称整棵线上树不变。
- listening Brain PID4186369/NRestarts0 active；main PM2 PID196861/restarts54，analytics196818/restarts11均online。后两者已不同于昨日快照，如实记录当前值，不误报“所有进程未变化”，也未据此归因为本轮故障。

## 单列超时观察项

附件仅说“一次独立唤醒session端点瞬时超时”，没有该次完整trace/精确时刻/Windows原始日志。为覆盖正式三轮前置唤醒，只读查询同设备16:00–16:13小窗口：9条ok、9条prefetch，未找到error状态流水；已成功签票9条的记账耗时9–30ms。仍无法唯一绑定客户端超时trace或网络/排队/签票/响应返回阶段。没有error行不证明客户端没超时，也不能选一个附近ok trace强配。

该观察项保持UNMATCHED_CLIENT_OBSERVATION，后续有该次客户端trace/时间再定向核对。它不阻断已有三条成功的功能用例，也不标记已修复。本轮未扩大拉取Worker日志或新增探针。

## 证据边界与收口范围

- 完整读取客户端附件并独立校SHA `44fc7582348fe2b534970cccc29d5c3fb984a4631b00c4d32fbdbecf05533342`。v386源码58f2a2d3、APK8e19aafd、1781 JVM PASS、UI与exit_completed同毫秒、5秒空闲关房、PREPARING修复等均为客户端交付声明；APK/Windows原始日志未随附件提供，38未独立编译或重跑。
- 用户明确接受“快照”用例；本附件没有该功能逐条明细，不能把上文listening配置snapshot握手当作“快照功能”验收证据。快照使用用户验收口径，服务端相关补充由45负责。
- 可收口：本轮三口令退出的Brain权限闭环；结合客户端/39证据限定关闭对应退出/UI残留/PREPARING竞态待验。继续保留：未定位session超时、未覆盖的可靠性/长稳/复杂唱歌及并发场景；不继承为整体永久PASS。
- 只读SQLite query_only/既有SSH，日志只提精确trace的device-session字段；未输出token、用户原文或音频。当前main out有界读取末16MiB且命中三条，error日志精确trace无命中；不宣称全量日志无错。

## 产物与恢复边界

`EVIDENCE-38.json`含三轮安全映射、36条证据一致性断言、当前事实及原件路径/SHA；`evidence-38/verify-closeout.py`可离线重算（这些是证据检查，不是36条产品测试）。原始安全取证目录：`/Users/fu-121/.local/state/p003-v386-closeout-20261105/evidence-38/`。

原树基线 `2f4eaf0f0aa84c9654ac18d0cb2ec0f97ecbc70a`，本轮仅新增收口文档/安全索引，不改源码、不cherry-pick、不部署、不新建设备会话。文档若需撤回仅撤回本次文档提交，不触及线上已发布版本；不改旧失败记录。三轮完整trace安全映射已交主13并共享文件供39读取。

署名：codex（OpenAI）｜2026-11-05 17:48 CST
