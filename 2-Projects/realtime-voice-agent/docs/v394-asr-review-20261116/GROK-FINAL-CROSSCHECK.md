# P003 v394 最终交叉核对

审查：Grok 4.6（xAI）。2026-11-16。只读。未扩调查、未读全仓、未联网、未跑新测试、未改业务/生产/记忆、未追租约发布器原始故障、未外传正文/PCM。旧报告不改写。

材料：`ROOT-FINDINGS.md`、`GROK-CODE-REVIEW.md`、`BRAIN-SAFE.json`、`WORKER-SAFE-V2.json`、`TARGET-KEYED-EVENTS.json`、`CURRENT-BRAIN-LEASE-V3.json`、`CURRENT-WORKER-HEALTH.json`。

## 认定

同意：诊断未覆盖的已证原因 = 倾听灰度租约过期（`canary_reason=lease_invalid`），Brain 把四轮派到普通主池 `rust-worker`；该池无诊断汇总。
同意：R4 `NO_FINAL` 根因仍未知。不可归咎搜索 / LLM / TTS / Android。
同意：当前倾听 health 新鲜，不能反证 11/11 历史已好。不要用现役新鲜度冒充历史，也不要仅凭历史过期重启现役。

## 同意

1. **四轮都进主池，原因是过期租约。**
   `BRAIN-SAFE.json` 四条签票：`selected_agent="rust-worker"`，`canary_reason=lease_invalid`，`lease_registered=true`，`jobs=0/max=2`。`lease_age_ms` = 5622348 / 5665308 / 5735131 / 5765415（93.7 / 94.4 / 95.6 / 96.1 分钟），`remaining` 全为负。Android `supports` 含 `listening_mode_v1|listening_voice_control_v1|oneshot_first_turn_v1`，`policy=capability`：能力已声明，不是端侧未声明。

2. **目标 trace 落在主池历史 PID，倾听/搜索同窗无目标。**
   `TARGET-KEYED-EVENTS.json` 四轮均 `unit=voice-worker-rust` `pid=4183959`。房间后缀干净：`4d25ee8e→94396820`，`ec176ee4→94396862`，`1de9809b→94396931`（R3），`ca456e74→94396962`（R4）。V2 倾听/搜索各 8 行空 tag，约 30s 间隔，无目标 id。V2 无 `connection/input summary`。现役 runtime：仅倾听池有诊断 env（`until=1794962794000`，allow `03800006`）；主池与搜索池诊断键为空。现役 PID/二进制 ≠ 11/11，只能作「现在诊断仍只在倾听」的旁证，不能冒充历史二进制。

3. **V2 已修房间尾 `}` 分裂；R3/R4 连接可按 room/job 归属。**
   目标房间不再出现 V1 的 `396931}` / `396962}`。R3 第二条 `asr connection timing` 186ms（dns0/tcp3/tls_ws183），`asr final received` FirstTurn chars4 + Rtc chars7，随后 turn/TTS。R4 第二条 171ms（dns0/tcp1/tls_ws169），仅 FirstTurn chars4，无 Rtc final、无 turn、无 TTS。重叠房 `94396932` 未进入四轮 target。V2 仍有 110 条 `room.suffix=er="asr"`（connect-family 误抽）；不分裂目标房，TARGET 已按 room/job 收回 R3/R4 连接，不扩查。

4. **R4 仍是问句无 final/无回答，不是卡房。**
   切 RTC `first_turn_no_task` + `catchup_samples=0`；第二条已 connected。`audio in` 160640/49756 非零是混合能量，不能当供应商写入。`control cancel` `cancelled=false` 后 `job closed`。与前审查一致。

5. **现役倾听 health 新鲜 ≠ 历史健康。**
   `CURRENT-BRAIN-LEASE-V3.json` 倾听 `health.json` age≈3.86s，`until` 剩 11137ms，`registered=true` `jobs=0`。`CURRENT-WORKER-HEALTH.json` 倾听/搜索本地 health age≈570ms / 598ms。取证时刻有效，不能反证 11/11 `lease_invalid`，也不能证明 `NO_FINAL` 已好。同文件里搜索 Brain `health.json` mtime 仍旧、`until` 大额为负；只记录，不追发布器。

6. **不可归咎搜索 / LLM / TTS / Android。**
   搜索池无目标 trace。R4 未 `turn committed`、无 TTS/playout，LLM/TTS 未接到问句。Android 能力已声明；同设备 R3 有 Rtc final 与回答。派单失败在 Brain 租约，不在端侧能力。

## 不同意 / 文义修正

1. **修正前审查开放分支 2，不改旧文件。**
   `GROK-CODE-REVIEW.md` 写「`rtc_seen` 有能量，`accepted=full=closed=0`：…或发送端当时是 `None`」自相矛盾。`rtc_seen` 只在 `stt_pcm_tx=Some` 时累加；`None` 时 `rtc_seen` 与 `accepted` 都不计。因此：`accepted=0` 不能从 `rtc_seen` 推导 sender=`None`；`rtc_seen>0` 且 `accepted=full=closed=0` 只能读成 sender 已是 Some、卡在 3200 以下。`rtc_seen=0` 且 `accepted=0` 仍分不开「无帧」与「sender None」。R4 当时没有这些计数，分支仍未观测。

无其他不同意。不把过期租约写成 `NO_FINAL` 根因，不把现役新鲜写成历史已修复。

## 收口

ASR 项仍不能收口。诊断覆盖失败已钉在过期租约→主池接房。R4 问句层仍停在「第二条已连，管道无 Rtc Final」。下一步仍是实际接房进程上的既有写出/响应计数，不是换供应商、补 final、或追发布器。
