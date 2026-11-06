# P003 普通对话不响应排查与服务端修复回执

时间：2026-11-06；取证11:15至12:26（北京时间）。

**结论：未完全解决。已修复主 Brain 的失效备用模型通道，已通过线上 HTTP 与完整 RTC 语音闭环；两台设备的音频再协商超时、部分会话频繁中断仍未闭合。不能将本回执当作安卓真机恢复验收。**

## 1. 本次到底卡在哪

| 层次 | 已核事实 | 结论与限制 |
|---|---|---|
| Brain 签票 | 20次签票5–12ms，中位6ms | 这批开房慢不在签票处理 |
| DeepSeek 主路 | 91次胜出；首段正文中位739ms、P95约1026ms、最大1298ms | 未查到主路在本窗明显变慢或失败；不是因为DeepSeek坏了才临时启用豆包 |
| Brain 备用路 | 本窗87次HTTP404；旧lite模型已下线。早先替代模型探针曾报订阅错误，12:22用户指定文件的同一凭据已实测可用 | 已修复，可恢复原有双路择快与冗余，但未证明它是所有不响应的主因 |
| RTC音频协商 | 03800006、04800006两机：数据通道已有offer/answer；新audio mid=1仍pending，约15秒NEGOTIATE_FAILED | 直接解释这两次建连慢、无下行音频；仅SFU日志尚不能判定offer未送达、客户端没处理还是answer回传/应用失败 |
| Worker输出门 | 03800006某轮LLM首字502ms、TTS首PCM246ms；Android未订阅音轨，5秒门超时，Worker主动DeleteRoom | 回答已生成但没有可用音频出口，不能归责模型；5秒保护存在于8月，早于搜索。本轮未盲目删除保护或拉长等待 |
| 回答中断 | 00100004一房19次提交/18次取消；04800006另一房10次提交/10次取消，许多正文几乎没播 | 新语音/提交持续抢占旧回复。尚缺现场口播与回声证据，不能认定全是误打断，也不能直接关闭打断功能 |
| 资源 | Worker/SFU未见本窗OOM或明显容量耗尽；其他设备同时有正常会话 | 不支持“整台服务器挂死”，不排除单连接/设备网络问题 |

异常普通轮次没有搜索任务等待证据。打断状态机和输出门在搜索上线前已经存在，但“没有搜索任务”不能单独证明所有搜索相关共享代码均无回归。我们没有据此为整套新功能作无回归背书。

## 2. 已实施的最小修复

主Brain原有“DeepSeek＋豆包并行，先返回正文的一路胜出”机制保留。本次没有撤下DeepSeek，也没有新加赛马策略。

- 原备用配置为`/api/coding/v3`＋`doubao-seed-2.0-lite`，实测404 UnsupportedModel；仅换model仍遇旧凭据的InvalidSubscription，旧凭据配plan亦401。
- 12:07先用同项目现役Worker已在用且从Brain实际验证成功的`/api/plan/v3`＋mini恢复服务。随后用户明确指定Air的“火山方舟 LLM key.rtf”，按此要求重新读取、验证并替换。
- 2026-11-06 **12:07:05.900 CST**上线，只改`VOLC_LLM_BASE_URL`、`VOLC_LLM_MODEL`、`VOLC_LLM_API_KEY`，重启一次主`p003-voice`；首次因仍有RTC房间拒绝发布，待三次确认空房后执行。
- **最终配置（12:23:32.475 CST）：用户指定文件的凭据＋`https://ark.cn-beijing.volces.com/api/coding/v3`＋`doubao-seed-2.0-mini`。** 文件凭据与最初服务器凭据相同；12:22实测coding下mini、2.1-lite均200，plan下401。因此不能再把它写成“当前失效密钥”，也不能未经证实断言早先订阅错误如何消失。新一轮同样在三次空房检查后发布，另建回滚点。
- 主Brain本轮共两次受控重启（首次恢复、第二次使用用户指定凭据）。Worker、SFU、Analytics、搜索/倾听专池、数据库、设备开关、业务源代码均未改。Worker自身独立灾备配置未轮换；本次替换的是所讨论的主Brain备用通道。凭据不在回执、仓库或群内分发。

官方确认旧lite模型已下线：[火山模型下线说明](https://docs.volcengine.com/docs/ark/coding-plan-personal-model-deprecation?lang=zh)。当前账户和新endpoint是否可用以本次实际HTTP测试为准，不靠文档推断。

## 3. 已完成的自检

| 测试 | 结果 |
|---|---|
| 最终配置下主Brain三次真实HTTP流 | 3/3 HTTP200、有正文、有DONE；首正文1553/534/498ms，均DeepSeek胜出，无新备用路报错 |
| 最终部署配置下直接调用备用provider | 首正文740ms，完整884ms，正常DONE |
| 最终配置下主池真实RTC闭环 | 独立无SN测试房，真实ASR→LLM→TTS→RTC接收通过；input ready366ms、output ready479ms（均从Worker assignment计） |
| 同轮生成/播放 | LLM首正文845ms；5段TTS首PCM275/303/342/282/271ms；实际收到约23.55秒有声音频，播放3200帧、underrun=0、自然SourceDrained结束 |
| 前一配置的验证记录 | 另有3次HTTP成功、一次RTC完整接收约11.63秒/欠载0。保留历史，但不拿它代替最终凭据的验证 |
| 音频测试隔离与清理 | 使用既有合成WAV；无真实设备身份、不写个人记忆、不唤醒用户设备；两轮房间、音轨、输入源均已关闭；12:25:56 ListRooms为空 |
| 运行稳定 | 12:25:56主Brain PID407592、重启计数56（本轮54→55→56）；3001/3006/3007/3008健康200；Analytics PID/计数未变；最终配置发布后provider失败日志0 |

首段有声音频可能是衔接语，不冒充正文首声。HTTP测试不是物理设备实听；RTC测试客户端也不是Android APK。这次正常闭环不能证明间歇故障已消失。

## 4. 下一个需要闭合的具体点

优先闭合音频再协商，不要求重跑埋点、方舟等无关用例。现有云端Android埋点只有connecting/error/idle，没有完整SDP处理明细，无法单靠这些事件唯一确定责任端。

独立源码审计后，主13再次逐字核对：v386的`LiveKitRoomAdapter.kt`与v371/v382相同，自动订阅为true。SDK缓存的answer绕过普通业务发送队列，不能仅凭业务collector卡住就断言SDP被卡住；缓存SDK也尚不能代表故障设备实际APK版本。

两条已有定位线索（只含尾号）：

| 尾号 | 北京时间 | 对齐信息 |
|---|---|---|
| 04800006 | 11:52:38–11:53:06 | trace `68942178-90dd-4c1b-9673-6ee50d362324`；房尾1793937158；11:52:54.965新增音频协商超时，重连后Worker input才启动，总耗时20.320秒 |
| 03800006 | 11:35:53–11:36:18 | trace `b874ed69-1614-4547-bdf1-b522558ccddd`；房尾1793936147；job `AJ_N5Zt7m3QYfag`；11:36:02.907首PCM，约11:36:07.980输出门超时并删房 |

安卓协作应提取同trace下收到subscriber offer、新audio mid、setRemoteDescription、createAnswer、setLocalDescription、发送answer的时刻/成功失败；同时给出当轮APK源码SHA、房间与重连generation。可以只给操作结果和异常码，无需原始用户语音、完整SDP、token或凭据。

设备恢复验证：选明确SN，关旧房再语音唤醒；自然说完一个普通问题后安静等待回复，连续3轮；再验证一次用户主动打断和再次唤醒。服务端按同trace核音轨订阅、首正文、首PCM、首播放帧、取消原因和播放欠载。当前尚未取得这一轮安卓实听结果。

## 5. 回滚记录

Brain私有备份目录：`/root/p003-voice-recovery-20261106/brain-provider-user-key-prechange/`。包含变更前环境、三键前后值、部署摘要及`rollback.py`；敏感原件权限600，不进Git。

```sh
python3 /root/p003-voice-recovery-20261106/brain-provider-user-key-prechange/rollback.py
```

回滚只还原本次三键，先核当前值没有漂移、当前没有RTC房间；不覆盖其他后来配置，不回灌数据库。最新回滚恢复到12:07已验证可用的Worker凭据＋plan配置，只用于本次凭据替换引发回归。12:07的更早备份另存`brain-provider-prechange`，它恢复的是旧lite失效模型，不能混用。回滚脚本语法已验，未实际执行回滚演练。

证据索引：同目录`EVIDENCE_INDEX.json`；原始私有证据不随文档外发。服务端运行与synthetic证据已核，端侧物理听感/剩余故障根因仍未验。

署名：codex（OpenAI）| 2026-11-06
