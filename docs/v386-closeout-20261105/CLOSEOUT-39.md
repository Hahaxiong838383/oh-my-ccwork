# v386 Worker三短口令退出限定收口

**结论：根据v386客户端真机回执及本轮已交叉核对的Brain历史授权闭环，可支持三条短口令退出、同房普通问答及PREPARING空闲竞态的限定功能收口。本轮Worker journal与现场二进制未独立复核：既有严格SSH链路两次超时，按主13明确裁定停止重试。不能写成“39独立核实3/3真实RTC全链路通过”或“现场binary未变”。**

## 三轮同窗对账

北京时间2026-11-05；身份由38只读库原件唯一映射，三轮均可信SN尾03800006，不按trace后缀猜设备。

| 退出口令 | 完整trace | story进入seq / epoch | Brain倾听授权close | 客户端报告的随后行为 |
|---|---|---|---|---|
| 结束倾听恢复聊天 | b04ef593-f44c-4b69-bb45-4c4d96b09c8b | 46 / 1 | 16:04:27.676，close-6 done | “天空为什么是蓝色的”得到回答，回答结束约5.5秒closing/idle |
| 恢复聊天 | eab501f1-16c5-49b3-a459-8eaeabfbe6e2 | 61 / 1 | 16:06:37.385，close-4 done | 同题得到回答，回答结束约5秒closing/idle |
| 小可结束倾听 | e843d07a-ee82-4b07-9b15-9fcf4ef62cc8 | 98 / 1 | 16:11:41.592，close-5 done | “1+1等于几”得到“1+1 等于 2”，回答结束约5.4秒closing/idle |

服务端已独立重算的范围：每trace唯一session/authority/entry；同一room/session/SN哈希；voice_control_v1；revision6/sourceGeneration1；mode_epoch1；成功授权lease分别4/2/3条；close时最近有效lease及grant仍覆盖；entry.closed=1、无revocation。最初lease false属于配置快照交接，随后成功授权，不据此判鉴权故障。详细时间、request_id及SHA见EVIDENCE-39.json。

**顺序与证据层级不能混写：**

- `proposal accepted → enter_completed → exit proposal accepted → exit_completed`、exit_completed与普通UI listening同毫秒、退出后同房问答及5秒空闲关房，来自本次Android原始回执声明。
- 服务端数据库的`close`是倾听授权关闭，发生在退出过程中；它不是Room删除，不应把上述16:04:27等时间当作回答后关房时间。
- 39本轮没有取得Worker历史journal或Android Windows原始日志，无法独立补齐proposal_id、exit seq、ACK completed后的epoch、精确播放结束及Room删除时间，不捏造逐包时序。
- 读取已发布5b3fdaac代码对象：`listening_voice.rs:71–91`限定active短退出；`listening_adapter.rs:505–518`保留proposal匹配/超时门，`:537–573`生成completed并清理内容、关闭前一epoch授权。该源码逻辑支持回执语义，但不能代替本轮实际数据包证据。

## 版本与PREPARING范围

三轮历史authority均记录正式runtime `5b3fdaac2b0e6d552a899ea7a941616cfbed2d5d`。38于17:44 CST只读取到Brain核准manifest SHA `c6013b898ddc292fd3b2f17c27260cefbcbb2ca4dda75090b6dabbd02663618b`，仍指向同runtime；39已读原件并重算相关一致性。

11月4日发布记录的无test-feature binary为 `7d39184c200053db5adbc59580517110762b0c3ac31928cc246d5f9162817de0`。这是历史已发布事实，本轮未读到实际/proc或盘上产物，不推断它现在维持或真实变化。11月4日PID/NRestarts和195秒稳定证据也不移作今日检查。

PREPARING遗留5秒idle计时器修复位于Android；客户端报告仅冻结PREPARING普通idle看门狗，保留控制器有界超时，NORMAL重置完整5秒预算。三轮真实成功报告支持该定向目标。本轮不需要Worker业务重构，也未修改Worker实现。APK SHA、1781 JVM通过及安装/6服务/Fatal/ANR数值均为客户端回执声明，39没有APK或Windows原件，未独立复跑。

## 两个独立观察项

1. **客户端session端点瞬时超时：未匹配、未判根因。** 附件没有该次trace/精确时刻。38对同设备16:00–16:13有界查询为9条ok与9条prefetch，记账9–30ms；这不能否定端侧超时，也不能强配附近成功trace。继续保留观察，不阻断三轮成功用例，不宣称已修复。
2. **当前运维SSH不可达：读取缺口。** 39使用原deploy_remote.py经Air、StrictHostKeyChecking=yes，两次均exit255，`Connection to 64.90.13.177 port 22 timed out`，远端只读脚本未执行，输出文件0字节。主13已明确允许按现有证据收口并保留缺口；主13另一次Studio直连同目标被StrictHostKeyChecking拒绝（本地无已知主机key），记录MAIN-WORKER-TRANSPORT.json，未降低校验或更换地址。本问题没有证据与客户端session超时同源，不能混因或以此否定历史用例。

## 交付、验证和恢复

- 原客户端附件SHA `44fc7582348fe2b534970cccc29d5c3fb984a4631b00c4d32fbdbecf05533342`已校验；附件中的Windows选取日志SHA `023a1f96…`只作引用，文件未提供，未冒称校过原日志。
- `evidence-39/verify-closeout.py`已实际运行：附件SHA及三trace授权/租约/close一致性断言通过。这是离线证据检查，不是新增3条产品测试。本轮未运行Cargo/JVM/HTTPjoint/RTC探针。
- 私有证据根：`/Users/fu-121/.local/state/p003-v386-closeout-20261105`；EVIDENCE-39列原件路径/SHA，仓内仅归档本回执、安全索引及客户端原件。无用户正文、音频或凭据。
- 原Worker树基线 `aeee1a3f691cdbfee03ed1c421f4f44483d6c0d1`，开始时clean。只新增`docs/v386-closeout-20261105`文档；原源码、旧失败回执与生产不动。文档回滚仅撤回本次文档提交，不回退运行源码/数据库/授权窗口；本轮不执行恢复演练。
- 快照功能由用户明确验收、45负责业务核验；不把倾听配置snapshot握手混作快照功能证据。未覆盖长稳、复杂唱歌、并发或所有语音可靠性，不标整体永久PASS。
- 下一步：主13汇总统一回执；无新缺陷证据不新增实现/部署。只有得到超时那次trace/时刻才定向关联该观察项。

署名：codex（OpenAI）| 2026-11-05
