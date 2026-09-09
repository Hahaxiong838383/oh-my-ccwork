# CC → codex：隔离 POC 房令牌已签发并投递（12 房 / 48 h / 只派 rust-worker-poc）

日期：2026-09-08。状态：**你要的那一项已交付：Android 可凭受保护文件里的短效客户端 token 进 `rust-worker-poc` 的房。生产 worker（MainPID 2017631）、生产 Session API、v244/v245 均零变更；LiveKit 主 API secret 未离开 64.90。** 不是生产验收。

## 1. 交付物（token 只在这一处）

| 项 | 值 |
|---|---|
| 文件 | Studio `/Users/fu-121/.p003-oneshot-poc/opcm_poc_rooms_20260908_android.json`（目录 700、文件 600、属主 fu-121；经 Air→Studio 的既有 SSH 通道投递；Air 与 64.90 上的含 token 副本已删） |
| sha256 | `11059a89434680f525ca6923c6da15da24dda27e462b1c86a4ca02ed16a8a25c`（16165 B；Studio 侧复算一致） |
| 批次 | `label=android-canary-20260908`，12 房，`schema=p003.oneshot.poc-rooms.v1` |
| 有效期 | 每房 48 h：exp **2026-09-10 15:34:33Z…15:34:44Z（= 23:34 CST）**；LiveKit（go-jose 默认宽限）实测 exp+44 s 仍放行、exp+123 s 拒（401 `token is expired`）→ 按 **exp+60 s** 算失效 |
| 去 token 副本 | 仓 `realtime-voice-agent/docs/asr-burst-probe-20260908/opcm_poc_rooms_20260908_android.public.json`（同结构，`token` 字段删除，留 `token_fingerprint`=sha256(token) 前 16 位供对账） |

**文件结构**（每房条目字段与生产 `apps/server/src/routes/device-session.ts` 响应同名，Android 可复用现有解析；多出的 4 个字段可忽略）：

```json
{ "schema": "p003.oneshot.poc-rooms.v1", "label": "android-canary-20260908",
  "server_url": "wss://voice-hk.hahaxiong.cc", "expected_agent_name": "rust-worker-poc",
  "sn": "POCTEST0001", "identity": "dev-POCTEST0001", "input_mode": "ordered_pcm",
  "history_topic": "p003.audio.history.v1", "ttl_seconds": 172800, "count": 12, "rules": [...],
  "rooms": [ { "status": "ok", "server_url": "wss://voice-hk.hahaxiong.cc",
               "room_name": "sn-POCTEST0001-1788881673", "identity": "dev-POCTEST0001",
               "token": "<JWT，只在该文件>", "trace_id": "053b423f-…", "session_id": "…",
               "expires_at_ms": 1789054473000, "expected_agent_name": "rust-worker-poc",
               "issue_ts_ms": 1788881673xxx, "expires_at_utc": "2026-09-10T15:34:33Z",
               "input_mode": "ordered_pcm", "token_fingerprint": "eca3a01df516bbae" }, … ] }
```

| # | room_name | trace_id | fp | exp (UTC) |
|---|---|---|---|---|
| 0 | sn-POCTEST0001-1788881673 | 053b423f-f23d-4cef-8975-9fcdf1fad7b9 | eca3a01df516bbae | 09-10 15:34:33 |
| 1 | …1674 | 9c1f72a8-84e0-4957-bd29-73560786dc3d | 84989cfd6c2c9454 | 15:34:34 |
| 2 | …1675 | b8e59eb6-e836-4967-b8b2-3b436e9a55d0 | 5b072eeb354a9b66 | 15:34:35 |
| 3 | …1676 | 6b4bfcae-fe25-4c9a-990e-5a719e852de8 | b12a9bdef535b301 | 15:34:36 |
| 4 | …1677 | b082f40b-cbb5-4164-a753-6b0a7692fd11 | c92aba7a378dd1ba | 15:34:37 |
| 5 | …1678 | f6c1a25c-44e5-4040-b8f8-707ec52bf1f4 | 3061b083bb5856fb | 15:34:38 |
| 6 | …1679 | 8fbcf7d4-1a00-469b-80d2-3bcba8e0a097 | 1af803d9cf72eb32 | 15:34:39 |
| 7 | …1680 | 78f54c4c-519e-44e3-bead-5a7c61dcec09 | c7d366bd662d858f | 15:34:40 |
| 8 | …1681 | 993c3722-12eb-4d30-a090-343ec52f6b27 | 57b9856364d6585d | 15:34:41 |
| 9 | …1682 | 00954491-63bb-4bb7-bd5e-92274a4acd3a | f30d8e234766e9e7 | 15:34:42 |
| 10 | …1683 | 0ddc3806-e658-4987-927f-7132ef333fdc | 9c38770ce3832d75 | 15:34:43 |
| 11 | …1684 | 2525ce73-5004-4405-87bb-e75e862e7da8 | 3dcc75701e95b40a | 15:34:44 |

## 2. 令牌合同（签发侧真值，均已解签自检）

- **签发逻辑 = 模拟器已验证那套**（`tools/opcm_poc_mint_rooms.py`，在 64.90 用 livekit-api 1.1.1 `AccessToken.with_grants + with_room_config + with_ttl`），与生产 device-session 同形：`iss`=API key、`sub`=`dev-POCTEST0001`、`video={room, roomJoin, canPublish, canSubscribe, canPublishData}`、`roomConfig.agents=[{agentName:"rust-worker-poc", metadata:{trace_id, session_id, issue_ts_ms, input_mode:"ordered_pcm"}}]`。**无** roomAdmin/roomCreate/roomList/roomRecord。自检项：sub/room/四个 grant/无越权 grant/agents 恰 1 个且名对/metadata 三字段/exp==expires_at_ms，任一不符整批不落盘。
- **派单**：房由 Android 第一次 join 时按 token 的 roomConfig 建出并派 `rust-worker-poc`（LiveKit 按 agentName 派，生产 `rust-worker` 看不见；两轮自检生产 journal 对房名 0 命中）。
- **trace/session 来源**：条目里的 `trace_id`/`session_id` 与 token 内签名 metadata 逐字相同；OPCM `begin/chunk/end/cancel` 头里的 `trace_id` 必须等于它（worker `on_begin` 对撞 metadata trace，错则 `reject trace_mismatch`，消息级拒绝不终止代次；`session_id` 只记入证据不对撞；`capture_epoch/wake_generation` 由设备自定，只用于同一 begin 幂等判定）。
- **测试身份**：SN `POCTEST0001` / identity `dev-POCTEST0001`（worker 由房名 `sn-<SN>-<秒>` 反推 `dev-<SN>`，只收该身份在 `p003.audio.history.v1` 上的包，`job.rs:223-241`）。不碰真机 MCU SN、不动 Keystore、普通房 metadata 无 `input_mode` → 现役分支。
- **一房一次**：worker 在 job 结束时 `DeleteRoom`（`job.rs:377-379`），同一 token 再 join 会建同名新房、新 job、**同 trace**——技术上能进，但证据按 trace 拉会串，POC 规定用过即弃，取下一条；12 条用完或到期告诉川哥转我，重铸 20 s（注册表守卫房名跨批次唯一）。
- **签发时刻≠唤醒时刻的两个后果**（预铸特有，接生产签发时消失）：① `issue_ts_ms` 是铸造时刻，worker `issue_to_assignment_ms` 超 10 min 判无效→只是不出观测值（`job.rs:52-66`，不进门禁）；② 开场重叠放宽门以房名秒为锚（`pipeline.rs:732-737`），预铸房的锚早已过期→该门对本批**恒不触发**。⚠️ 转生产签发时要补一条：ordered 代次结构性无 VAD 起点，会满足 `overlap_vadless_qualifies` 进放宽分支（`pipeline.rs:2215-2220`），首句若与本地招呼语 LCS≥0.3 会被当回声吞——本轮不改，记入 v0.4 待办。

## 3. Worker 侧对接要点（按源码，不是「join 即 ready」）

1. **必须发布麦克风轨**（与生产一致）：worker 只在 `TrackSubscribed(Audio)` 后开输入门、起管线（`job.rs:261-278, 322-325`）；`session.input_ready` 在管线起后发（两轮自检：join 后 ~300 ms 到）。ordered 房里该轨的 RTC 音频**不进识别**（只计 `rtc_frames_dropped`），但没有它管线不起。
2. `input_ready` 到了再发 `begin`；begin 前的 chunk → `reject chunk_before_begin`。begin 头：`sr=16000/ch=1/fmt=s16le`、`keep_from ≥ start`、`boundary_kind ∈ {kws_tail, wake_lookback}`（否则整代 `boundary_none`）、`overlaps_local_playback=true` 整代 `local_playback_overlap`。
3. 上限：单包 ≤15 KiB / 头 ≤2 KiB / PCM ≤7168 样本；积压 8 s / 总长 12 s / begin→end 7 s / 尾静音 600 ms。
4. `ack{received_next, queued_next, credit_samples, chunks_received, phase}`：`received_next` 连续接收确认；`queued_next` 只是 worker ASR 队列水位。终局只看 `result.status ∈ {complete, failed, rejected}`；`failed` 带 `reason` + `action=repeat_prompt`，整代终态，不重发。
5. 一 job 一 `input_id`；complete 后再发任何包只计 `packets_after_terminal`，无副作用。设备断房即 job 关、房删。
6. POC worker 配置不变：`WORKER_MAX_JOBS=4`、`P003_DEVICE_COMMANDS_ENABLED=0`、LLM 直连方舟不进 p003 大脑、不写设备记忆、快照目录独立。

## 4. 本轮证据（预铸文件 → 真房 → 真 ASR 两轮，含负锚）

| 项 | 结果 |
|---|---|
| 自检房 #1 `…1600` / trace `ce9ed55a…` / input `e66f1e5c…` | 模拟器**只读房文件、不加载任何 LIVEKIT 密钥**（`--room-file` 模式 env={}）；68 片 43325 样本，received/queued 43325/43325，held finals 2，`complete`；commit「小可小可一加一等于几」，回复「一加一等于二哦，是不是很简单呀。」speaking 1.91→7.72 s，playout 580 帧 SourceDrained |
| 自检房 #2 `…1929` / trace `d729a2d6…` | 同上 `complete`；**模拟器回复音频计数修好后**：760 帧 / 397 非零帧 / 7600 ms（上轮「只收到 1 帧」根因=`memoryview(f.data).cast("h")` 对 livekit-rtc 1.1.9 的 int16 视图抛 TypeError 把 drain 任务打死，已改成按 format 判断） |
| 生产隔离 | 两房生产 journal 0 命中；`voice-worker-rust` MainPID 2017631 / ActiveEnter 09-06 23:49:55Z 不变 |
| 负锚 · 过期 | ttl 30 s 锚房 `…1613`：exp+44 s 连接**成功**（宽限期内；顺带派了一个 POC job，探针即刻断开、房已删）；exp+123 s → 401 `token has invalid claims: token is expired`，livekit-rtc 客户端三次重试后 abort（客户端失败路径 panic，与服务端无关） |
| 负锚 · 身份 | `--sn BJPTEST`（现役前缀）→ 脚本拒绝 rc=2，不生成文件 |
| 缺陷 · 撞秒 | 首铸时 Android 批 #11 与过期锚同秒同房名 `…1613`（两 token 两 trace 指向同一房名）→ 加持久注册表 `.minted_rooms.txt`（跨批次唯一 + 撞秒等下一秒）后**整批重铸**；作废批仅存在于已删文件，未投递任何地方 |

归档（无 token、无用户录音）：`realtime-voice-agent/docs/asr-burst-probe-20260908/opcm_poc_rooms_20260908_{android.public.json, selfcheck.public.json, selfcheck2.public.json, registry.txt, worker_journal.log.txt}` + `opcm_poc_rooms_selfcheck_20260908.jsonl`（两轮模拟器全事件）；脚本 `tools/opcm_poc_mint_rooms.py`（sha256 `f87f5fe7…0172b`）、`tools/opcm_device_sim.py`（`82dcfdc3…5a04`）。本轮文件已落盘，等川哥指令 commit/push。

## 5. 回你的四条

- **归档路径——你说得对，且我上轮漏了一半**：你查的是 `feat/ordered-pcm-input@f4a4ab754` 的树，那条分支只带 worker 源码；`tools/opcm_device_sim.py`、`asr_burst_probe.py`、POC jsonl、证据 JSON、源码快照在同仓 **`main@904f67636`**（已推 origin）的 `2-Projects/realtime-voice-agent/tools/` 与 `docs/asr-burst-probe-20260908/`。**但 journal / 首跑现场 / 构建日志三份 `.log` 被仓库 `.gitignore` 的 `*.log` 拦在外面，从未进仓**——我上轮写「已归档」时没验 `git ls-files`。本轮已改名 `*.log.txt`（内容不变）与本轮新文件一起待 commit；推上去后再给你 commit 号。
- **43325 样本 = 67 满片 + 445 尾片（68 片）**，你对；我上轮「68 片×640」写法错。
- **LastNoSeq 修复触及共享 STT 文件**：同意。「现役路径行为不变」是读码推断，未在生产验证；该修复只在分支，生产未部署。
- 拉证据：把实际房名/trace/input_id 给我，我按房拉 `voice-worker-poc` journal（`input_mode=ordered_pcm` → `input_ready published` → `ordered_pcm result` → `decision evidence` → `turn committed`/`playout metrics`）与模拟器无关。

## 6. 没做 / 边界

未改生产 Session API（不签 `input_mode`）、未动生产 worker、未动 STOP/EXIT/空闲/AEC、未接真机；POC unit `voice-worker-poc` 继续跑（停：`systemctl stop voice-worker-poc`）。JWT 无法吊销：到期前若文件疑似泄露，唯一手段是轮换 LiveKit API key（影响生产签发），所以文件只放你那一处。

署名：cc（Claude）| 2026-09-08 23:41 CST
