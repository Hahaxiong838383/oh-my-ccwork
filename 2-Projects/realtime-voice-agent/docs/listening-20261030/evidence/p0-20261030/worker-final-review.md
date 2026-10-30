# P003 Worker P0 最终审查

**结论：最终候选 b7c942201d45a6fe92a26488448f4dfb0c1db4b0 的源码与分层测试证据复核通过，未发现阻断本轮服务端 P0 收口的问题。可继续 Android 真机联调；本结论不等于已部署生产或真机整体验收通过。**

审查只读，不改业务代码、不操作生产、不启动 Cargo/RTC。审查输入哈希见 worker-final-review-inputs.json；早期发现与失败记录见 worker-incremental-review.md。

## 源码审查

| 变更 | 结果与范围 |
|---|---|
| c61656e7 构建绑定 | 编译期 SHA 显式必填；Cargo JSON 定位实际 executable，避免外置 target 核错产物。本地独立脚本 3 项通过。格式校验不替代内容 manifest，最终已结合实际运行 SHA 核对。 |
| c61656e7 测试传输 | 正式默认构建仍只允许既有生产 HTTPS；listening-rtc-test 仅 literal loopback、拒生产 origin，共用 Client/Service 判据，redirect 关闭。测试二进制不得部署。 |
| 68f2b586 RTC 取证 | pipeline 仅新增 trace/turn/时序日志。探针校验真实 Agent kind/name/identity，覆盖 control、ordered 首句、音频、字幕、metrics。 |
| 7e75a73f 容量恢复 | 任务开始/结束触发 Notify，单 WS 循环发送时读取当前 count，合并通知不保存旧 Full 快照；max_jobs、search gate 与30秒兜底保留。2红→8绿，max_jobs=1 真实新房已验证。 |
| e0a83f81 删房及探针退出 | 倾听 metadata 普通房采用2×2秒＋250ms，总4.25秒≤旧5秒；普通非倾听仍单次5秒，搜索保原策略。401/403/redirect不重试。探针显式关闭 AudioStream/AudioSource，实际进程退出码复核为0。 |
| d9acb68b / b7c94220 ASR 预热 | 共用 run_pipeline 首PCM前淘汰年龄≥5秒、已关闭/已结束或排队旧事件的预连；先 abort＋有界 join 旧 task，再丢弃旧 tx/rx 并建立新流，后纳入原清理 guard。保留其他预组装；普通/搜索同样适用，年轻健康预连原样复用。年龄门单独覆盖4999/5000/10207ms，删除年龄条件 mutation 为2过1红，恢复后3绿。 |

## 最终 b7 实证

最终独立来源：`root-final-rtc-snapshot.json`。run=`rtc-run-1793354897591398945`，结束1793354994850257641，max_jobs=1；进程 executable 的实际 SHA 与 manifest、artifact-sha 一致。

- 正式无 feature 候选 SHA256：`830823de3acf43f4692dc19d4e436e6c881a05349bcc78a4f945f19f2570d873`。
- 隔离 RTC 测试 SHA256：`d74855a8110fa2623942255ab7d07d8a4c2e0fb13dc40870280118e866b38929`。
- 探针 SHA256：`ca006304d1b0eaf208cbb166c00aa5cca6d69b26fd7699b7140ffaeaf36729eb`；Brain bundle=`05752431e4cb9fcdca06021ee4654525434f6e2cf7ed9d1ae26e6b6e03d776f5`。

| 场景 | normal | lease_timeout |
|---|---|---|
| room | sn-BJP00326103099999938-1793354899 | sn-BJP00326103099999938-1793354957 |
| trace | p0-39-d97710cb-1d1d-49d0-88a9-3e0b812265af | p0-39-5eff48f8-3aba-48af-a7fe-927be0df98b6 |
| 子进程/结构化结果 | rc0 / passed=true | rc0 / passed=true |
| 预连接接管年龄 | 10968ms | 10919ms |
| 换新及首句 | 有换新日志；first_turn_listening_command；catchup22720 samples | 有换新日志；first_turn_listening_command；catchup36000 samples |
| 自动删房 | attempt1，客户端55855ms RoomAPI absent | attempt1，客户端35977ms RoomAPI absent |

两房都延迟客户端发布麦克风11000ms；预组装稍晚启动，所以实际年龄为10.968/10.919秒，不能写成严格≥11秒。两者均超过原失败10.207秒，已覆盖故障窗口。没有 fallback 删房，没有 cleanup_error。

normal 在14.059秒完成语音首句双确认进入；普通叙述静默，随后真实反馈音频、退出后普通聊天音频/Agent最终字幕/metrics均有正锚。Brain恰一次feedback请求含即时续讲尾句 `紫色风筝` marker，证明首句及续讲进入链路。

lease_timeout 在14.409秒进入，23.665秒暂停隔离Brain，35.934秒客户端实际断线且零音频，35.977秒 RoomAPI absent。该场景真正执行了租约故障注入，非在进入前失败。

同实例 max_jobs=1，normal 10:09:15.346关闭、15.348发布Available；17.966接下一房，早于10:09:30周期心跳，容量修复在最终候选上继续有效。

主会话独立 root-linux-results.json：最终 b7、83项输入匹配，Linux545项＋HTTP joint2项 exit0；39另有编译 feature 传输2项通过。两项 ignored 不计入通过数。本审查另独立运行了本地构建脚本3项、探针脚本3项，均通过；未竞争远端构建锁。

## 分层保留的 e0 证据

e0完整矩阵 run1793353699185182498：normal/barge/missing_ready/proposal_timeout/disconnect/revoke 6项均 rc0、passed、RoomAPI absent；lease场景在注入前失败，原失败完整保留。同e0独立定向lease run1793354067400856608随后通过，但未将首批改写7/7。

原失败具体链路：RTC signal重试导致connect10183ms，ASR预连接管age10207ms，首PCM后收到火山45000081 waiting next packet timeout，ordered变asr_unavailable，未进入倾听。最终 d9/b7 通过上述有意延迟接管验证关闭此项缺陷。

e0 barge使用同一52字反馈作不中断对照（9.969秒）；插话时真实SpeechStart→abort(was_feedback=true)，provider finished=false且仍待播203ms。客户端停止距上行1.167秒、无补播，排除了自然播完假通过。该后半段逻辑未受最终预热补丁影响，按e0证据保留，**不冒称b7全7场景重新跑过**。

## 证据边界及交付建议

- 已跑真实 ASR、讯飞 TTS、SFU、Worker、隔离 Brain 权限链；文本模型为确定性合成回复，Android为软件替身。真人说话/唱歌听感、本地停音及端侧界面仍待真机验收。
- filler资产实载，但Brain策略实际 probability=0.25，普通正锚为probability skip；未构成强制filler正反对照，不能宣称该分支RTC全验。
- ordered首句、转RTC和catchup已验；可选 ORDERED_LOCAL_RECEIPT_ENABLED=false，ordered本地receipt未验。listening.local_ready双确认是另一机制，已验。
- 较早一次 DeleteRoom 5秒超时后同版本复测成功；e0只属有界稳健性修复，网络根因没有被证明解决。
- ASR修复针对pipeline初次接管；不表示已覆盖所有长时网络/第二条stt2闲置问题。无证据要求本轮继续扩展。
- 本轮未操作生产。正式无feature候选具备后续部署验证基础；是否发布及最终远端HEAD/clean/服务回读由主会话统一完成。

署名：codex（OpenAI）| 2026-10-30 18:15 CST
