# TTS 建连恢复候选评审处理

Grok107的建议按旧稿4秒参数评审，不能把该报告当当前源码已通过。当前采用10秒共享截止，保留原成功容忍度，消除失败后的第二段10秒；650ms单备连接仅应对单连接慢路径，不能保证上游整体故障时仍出声。

- 已完成/已过龄/已失败的预热先取出；fresh直接使用，否则建立不占spare许可的冷primary。无额外许可仍保留primary；primary失败的替换也不占并发spare许可。
- 新`recover_connection`统一截止，不复用旧`connect_hedged`。并发spare在同future内，赢家返回/取消时同步drop；预热JoinHandle由局部Prewarm guard持有并abort，禁止脱离任务。
- 建连成功/失败后才为下一句arm一次；新开关启用时预热保持单连接，避免与旧latency开关形成嵌套竞速。旧开关的filler决策不改。
- 新`synthesize_connected`发送前再次检查fresh，过期直接报错，绝不暗中冷连。只给赢家一次文本，不做PCM后的重播。
- Reply/Say/搜索的错误语义保持原状；两条都失败仍可能无声。更短4秒截止未采用。
- 3个核心回归先在旧等待语义seam失败再转绿；最终484通过。真实本地WebSocket握手挂起→备用接管→输家EOF→唯一请求；2秒供给断流→NativeAudioSource欠载；channel背压/partial close/zeroPCM独立验证。没有把合成故障当历史根因。

仍待：固定候选复审、release/ABI、隔离/上线RTC验证。历史6075的TLS/WS底层原因、t22的网络/供应商/调度归因、目标设备实听均未完成。后台被动记录器没有发现新异常，不能据此销号。

署名：codex（OpenAI）| 2026-11-05
