# One-shot Android 真机 POC 房 worker 侧证据（拉取时刻 2026-09-09 08:10 CST，来源 64.90 voice-worker-poc journal + /root/eot-snapshots-poc/events.jsonl；生产 voice-worker-rust journal POCTEST 计数 0）

| 房(后 4 位) | 派单 UTC | job_id | input_id(前 8) | keep_from/first_sample | 收样本(≈s@16k) | chunks/packets | 序 | 转写(turn committed) | chars | eou_ms | commit | dev.cmd |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| …1673 | 09-08 16:39:50 | AJ_x56SEeJnZDci | c763bfc6 | 0 / 0 | 15232 (0.95) | 24/26 | end_before_final | 不要开灯 | 4 | 400 | 1 | 0 |
| …1674 | 09-08 16:40:39 | AJ_isNDHrsYVpop | c3fa42dd | 0 / 0 | 35152 (2.20) | 55/57 | end_before_final | 小可小可不要开灯 | 8 | 447 | 1 | 0 |
| …1675 | 09-08 16:46:12 | AJ_5Fay6DKegowf | 52f81cf5 | 0 / 0 | 35152 (2.20) | 55/57 | end_before_final | 小可小可不要开灯 | 8 | 439 | 1 | 0 |
| …1676 | 09-08 16:52:31 | AJ_gihGEziWWfDd | 526ad8e9 | 0 / 0 | 35152 (2.20) | 55/57 | end_before_final | 小可小可不要开灯 | 8 | 414 | 1 | 0 |
| …1677 | 09-08 23:41:16 | AJ_PqcP3W7nkoEC | 550ee7ef | 854240 / 854240 (53.39 s) | 95680 (5.98) | 164/166 | final_before_end | 小可小可1+1等于几 | 10 | 407 | 1 | 0 |
| …1678 | 09-08 23:55:41 | AJ_TzjriangTbdr | 9c21ad25 | 0 / 0 | 19376 (1.21) | 31/33 | end_before_final | 一加一等于二 | 6 | 448 | 1 | 0 |
| …1679 | 09-09 00:05:41 | AJ_u2bUKjojyrw7 | d4db8efc | 234400 / 234400 (14.65 s) | 95840 (5.99) | 168/170 | final_before_end | **可小可出个长句测试一下（首字「小」缺）** | 11 | 404 | 1 | 0 |

全部 7 房共同值：status=complete / outcome=committed / finals=1 finals_held=1 / packets_rejected=0 / chunks_duplicate=0 / queue_full_events=0 / stream_interrupted=0 / samples_cropped_before_keep_from=0 / silence_samples_submitted=9600 / backlog_peak 3200–3680 / rtc_frames_dropped 185–319（ordered_pcm 模式 RTC 音频按设计丢弃）/ 每房 1 条 WARN=「job termination requested (P2: relying on room close)」（已知良性）/ playout underrun 0 / job uptime 22–23 s / participant 主动断房→room deleted。
两类代次：A 型（1673/1674/1675/1676/1678）keep_from=0、0.95–2.2 s、设备 end 先于 final；1674/1675/1676 样本数完全相同 35152 → ⚠️推断：同一段录音重放非三次实说。B 型（1677/1679）keep_from 非零（设备绝对样本索引 53.39 s / 14.65 s）、固定 ≈5.98 s 窗、ASR final 先于设备 end。
丢首字归因边界：worker 只收到 keep_from 起的样本（samples_cropped_before_keep_from=0=设备没发 keep_from 之前的音频），POC 分支 ordered_pcm 路径无 PCM 落盘能力（eot 快照只在 RTC VAD 路径触发，events.jsonl 全部 snapshots=0）→ 「小」是被设备切点切掉还是 ASR 吞掉，worker 侧证据不可判，需 codex 端侧 keep_from 前后 PCM 或给 POC 加落盘开关（改分支+换 POC unit，等拍板）。
codex 记账 /Users/fu-121/.p003-oneshot-poc/used_rooms.json：7 条 reserved（1673…1679），trace 与公开副本一致；reserved→worker 派单 6.6 s / 63 s / 27 s（端侧流程时长）。
剩余未用房：…1680–1684（5 房），exp 2026-09-10 15:34Z=23:34 CST。
