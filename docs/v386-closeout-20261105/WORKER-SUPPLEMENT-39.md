# v386 Worker现场与历史日志补验（最新结论）

**已补齐原收口中的Worker现场binary与历史journal缺口。实际运行/proc、磁盘binary及release均对应v384正式发布的5b3fdaac / 7d39184c；三条目标trace可见退出口令ASR、同房普通问答输出及有界收房。结合原客户端回执与Brain权威证据，本轮三口令功能可限定收口。Android消费proposal/ACK及UI同毫秒仍属于客户端证据，不能改称服务器独立验证。**

原`CLOSEOUT-39.md`、`EVIDENCE-39.json`内“未取到Worker现场证据”保留为早期阶段历史，已由本补验替代。用户纠正有效：此前只是调用路径失败，不是Worker离线，不能否定会话93的监控修复。

## 正确路径与读取范围

完整读93发布文档及补充`worker-supplement/ROUTE-93.md`后，实际成功路径为 **Studio→Air发起最终SSH认证→home-studio-mesh仅TCP `-W`转发→hk2**。旧`transport.py`把最终认证放在home，本次返回Permission denied；原Air直连超时、该鉴权失败均留证。沿用Air既有身份和严格hostkey，不复制凭据、不改SSH配置、不新增密钥。

使用93已核argv的私有只读封装。初次脚本遇到journald `MESSAGE`为字节数组而非字符串，解析失败；只增加本地reader的数组解码兼容，重新固定输入SHA `6219538ba0261322f715f3212a3ff0053996cc10bdd40c3f86961daa80c34eac`，封装仍仅接受固定只读payload。未修改生产产品代码。

实际只读`p003-listening-worker`的2026-11-05 **16:03–16:13 CST**窗口，712条源journal、590条脱敏保留事件；最终证据在私有`worker-supplement/worker.json`。ASR/TTS正文只保留附件授权测试句，其他正文省略，残留引号文本也再次移除。未扫45小时、未启动新RTC、未重跑Cargo/JVM/HTTPjoint、未部署或修改服务/env/名单/数据。

## 现场运行基线

2026-11-05 **18:15:00.855 CST**只读快照：

| 项目 | 实测 |
|---|---|
| unit | p003-listening-worker，active |
| MainPID / NRestarts | 2750511 / 0 |
| 进程启动 | 2026-11-04 18:18:27 CST |
| release build | `5b3fdaac2b0e6d552a899ea7a941616cfbed2d5d` |
| /proc运行映像、磁盘产物、release声明 | 三者SHA均为`7d39184c200053db5adbc59580517110762b0c3ac31928cc246d5f9162817de0` |
| release产物大小 | 77972432字节（元数据声明，本次未单独stat） |

哈希与11月4日正式无test-feature产物一致，不是270df2ab测试feature产物。历史窗口日志PID也全部为2750511；本轮未推断其他池或整机进程均未变化。

## 三轮可见时序

下表均为服务器journald时间，显示到毫秒；非Android时钟，也不把SourceDrained当物理喇叭播放结束。完整trace/session/脱敏room、事件索引和原件SHA见`WORKER-SUPPLEMENT-39.json`。

| 退出口令 / trace末8位 | 退出ASR final | Brain授权close | 同房普通问题commit | 正文首帧 | SourceDrained | 端侧cancel | 房间删除 |
|---|---|---|---|---|---|---|---|
| 结束倾听恢复聊天 / 96b09c8b | 16:04:27.614 | 16:04:27.676 | 16:04:34.760，天空为什么是蓝色的 | 16:04:36.109 | 16:05:11.759 | 16:05:17.310 | 16:05:17.740 |
| 恢复聊天 / abfbe6e2 | 16:06:37.307 | 16:06:37.385 | 16:06:45.986，同题 | 16:06:47.037 | 16:07:39.933 | 16:07:45.414 | 16:07:46.383 |
| 小可结束倾听 / 4ef62cc8 | 16:11:41.535 | 16:11:41.592 | 16:11:54.484，1+1等于几 | 16:11:55.633 | 16:12:01.971 | 16:12:07.476 | 16:12:07.803 |

- 三房均只有一次job accepting，目标区间没有其他job接入；由Brain唯一trace/session/room映射、room日志锚和同PID不重叠时窗关联无room的ASR行，不能宣称每条ASR原行带trace。三trace的`session.input_ready`实际`publish_ok=true`均有直接日志。
- Brain entry seq分别46/61/98、mode_epoch1、revision6/sourceGeneration1；成功lease分别4/2/3条且覆盖授权close。授权entry开始到close之间，目标房区间未出现普通commit/TTS合成记录；并有相应`listening acoustic speech_start`。进入proposal/enter_completed不在journal逐包记录中，不伪造其确切时刻。
- 首两题均产生LLM响应、TTS与正文首帧；第三题TTS明确含授权测试答案“1+1 等于 2”。这证明服务端生成并送出链路，设备实际听到仍参考客户端回执。
- SourceDrained→cancel分别 **5550.986 / 5481.137 / 5505.341 ms**；随后三轮均`participant disconnected(action=Close) → pipeline closed → room deleted(attempt=1) → job closed`。SourceDrained→服务器删房分别5980.429 / 6449.610 / 5831.988 ms，不能把服务器删除耗时写成Android idle预算超时。
- Brain授权close发生在普通问答之前，Room删除发生在普通问答之后；二者含义与顺序现已独立核实，不会把退出倾听误记为立即关房。

## 需保留的观察与证据边界

1. **首轮一次underrun294ms。** 最终playout指标`underrun_count=1 / underrun_ms=294`，仍以SourceDrained正常结束；第二、第三题各0。该样本不阻断本轮倾听退出收口，但不能声称音频零异常，也不据此推断用户听感。
2. **第三轮退出后又出现短句。** 16:11:44.543又有“小可结束倾听”final、16:11:44.684普通commit；此前16:11:41.592授权已close。随后明确1+1问答同房成功。符合短口令仅在倾听态触发控制的边界；不将其当二次成功退出或旧输出补播，不凭文本判定是用户重说还是声学回灌。
3. **proposal/request/accepted/completed与UI。** 固定5b3fdaac `pipeline.rs:1524`经`:1709 publish_json`发送倾听控制，无逐包成功INFO日志；原journal不能恢复各proposal_id/exit seq/ACK后epoch。Brain close request_id/epoch与Android报告的`proposal accepted→enter_completed→exit accepted→exit_completed`互补，不能把数据库close或缺日志当作ACK消费的独立证明。Android UI同毫秒、PREPARING竞态、APK/JVM仍按客户端回执边界，不新增测试宣称。
4. **客户端那一次独立session超时仍未匹配。** 本补验未取得它的明确trace/时刻，不与旧运维路径失败混因，不扩大排查或宣称已修复。

## 校验、归档和恢复

已实际运行`worker-supplement/verify-supplement.py`，校验三binary声明相等、三trace同房时序、lease close先于问答、输出排空后cancel/断连/pipeline/删房顺序、无重入job。这是现有证据一致性检查，不是新增产品或真机测试。JSON逐项索引输入SHA与行号；服务器日志只能证明上述可见边界。

私有证据根：`/Users/fu-121/.local/state/p003-v386-closeout-20261105/worker-supplement`。原分支基线`849d9bae723c3366c5a66839b8e96a9f49752d80`，本轮只追加补验MD/JSON和最新入口，旧失败证据不覆盖。文档撤回只revert本补验提交，不回退已发布源码/产物、数据或凭据；未执行生产恢复演练。主13负责汇总及Air统一交付。

署名：codex（OpenAI）| 2026-11-05
