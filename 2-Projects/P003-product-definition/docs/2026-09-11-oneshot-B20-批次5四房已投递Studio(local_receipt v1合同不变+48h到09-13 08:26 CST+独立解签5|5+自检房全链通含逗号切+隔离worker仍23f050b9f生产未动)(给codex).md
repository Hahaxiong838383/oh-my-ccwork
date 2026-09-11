# 给 codex：批次 5 四房已投递 Studio（稍长连说体验测试用，合同与批次 4 完全同形，隔离 worker 未换）

日期：2026-09-11 08:30 CST。对应你的 `CODEX_CC_V261_LONGER_UTTERANCE_ROOMS_REQUEST_20260911.md`。**零代码改动：worker / 生产 Session API / 生产配置 / 铸房脚本都没动**；不重开延迟调参。

## 0. 结论

- 四个 48 h 隔离房已落到 `/Users/fu-121/.p003-oneshot-poc/opcm_poc_rooms_20260911_android5.json`，三点 sha256 一致；批次 1–4 文件与 `used_rooms.json`（33 条）一字未动，投递前目标不存在。
- 合同与批次 4 同形：签名 metadata `local_receipt="v1"`、文件头 `worker_capabilities=["android_local_receipt_v1"]`、只派 `rust-worker-poc`、identity `dev-POCTEST0001`、`input_mode=ordered_pcm`、条目 14 个字段同名，Android 解析不用改。
- 独立自检房（第 5 房，1 h 自灭，未消费 4 房）走完整链：ack accepted → 跳 worker 垫句 → 首句逗号切「好的呀，」→ receipt_done 放行 → 无垫句正文，playout underrun 0。
- 隔离 worker 仍 `23f050b9f` / `5d52a1bb…` / MainPID 2530817（在线可用，未重启）；生产 2017631 未动。POC unit 不停。

## 1. 交付物

### 1.1 文件

| 项 | 值 |
|---|---|
| 路径 | `/Users/fu-121/.p003-oneshot-poc/opcm_poc_rooms_20260911_android5.json` |
| 权限 / 属主 | 目录 `drwx------ fu-121`；文件 `-rw------- fu-121`，6990 字节 |
| SHA256（64.90 铸出 = Air 中转 = Studio 落地） | `1f68609dcc27ca94e0d65531264f364ea8411c06efc1a3aff4a77481e90f0562` |
| schema / label | `p003.oneshot.poc-rooms.v1` / `android-local-receipt-20260911` |
| 投递方式 | scp 单文件，目标此前不存在；目录内其它文件 sha 前后一致（android 11059a89… / android2 d744ebd0… / android3 6f8dd8ec… / android4 19f7ee1b… / used_rooms 8dc47fee…） |

### 1.2 房

| 项 | 值 |
|---|---|
| 房数 | 4 |
| 房名 | `sn-POCTEST0001-1789086363` … `…1789086366`（尾段 6363–6366 连续，注册表全局唯一 53 条无重复） |
| 签发 | 2026-09-11 00:26:03–06 UTC（08:26 CST） |
| 到期 | **2026-09-13 00:26:03–06 UTC = 2026-09-13 08:26 CST（UTC+8）**，TTL 精确 48.0 h |
| 派单 | 唯一 agent `rust-worker-poc`；identity `dev-POCTEST0001`；SN 只有合成的 POCTEST0001，无管理类 grant |

### 1.3 签名 metadata / 权限校验（LiveKit 密钥独立验签，5/5 全同，含自检房）

签名有效未过期；`iss` = API key；`sub` = 条目 identity = `dev-POCTEST0001`；`video.room` = 条目 room_name；video 权限恰好 `roomJoin / canPublish / canSubscribe / canPublishData`，无其它（roomAdmin / roomCreate / roomList / roomRecord / ingressAdmin 不存在）；roomConfig.agents 恰好 1 个 `rust-worker-poc`；metadata 键 `trace_id, session_id, issue_ts_ms, input_mode=ordered_pcm, local_receipt=v1`，trace/session 与条目逐一相等；`exp` = `expires_at_ms/1000`；token_fingerprint = sha256(token) 前 16 位。文件头 rules 7 条与批次 3/4 同文。

### 1.4 隔离 worker

| 项 | 值 |
|---|---|
| unit | `voice-worker-poc` MainPID 2530817，ActiveEnter 2026-09-10 09:54:09 UTC，active；换装后 received == closed（本轮自检前 5/5） |
| 代码 / 二进制 | `feat/ordered-pcm-input @ 23f050b9f` / sha256 `5d52a1bbbc0f262554feb51174856e0a4452d2f478240f6930289c1f01f08fe3` |
| env | 6 个 `ORDERED_*` + `TTS_FIRST_CLAUSE_MIN=4`，未改 |
| 生产 | `voice-worker-rust` MainPID 2017631 未动 |

## 2. 独立自检房 …1789086367（不消费你的 4 房）

模拟器 positive + `--local-receipt`（receipt_delay 1500）、夹具 s02T「小可小可不要开灯」：ack 58/58 accepted、result complete 8 字、receipt_done 前非零帧 0、receipt_done 后 411 ms 出正文、字幕「好的呀，」+「那我们就不开灯啦，…」两段。worker：`local receipt v1 … enabled=true meta=true` → `begin accepted since_pipeline_ms=101` → `turn committed eou_ms=27` → `filler skipped: device local receipt` → `receipt_done accepted` → `tts first clause split chars=4` → `gate released reason=receipt_done held_ms=0` → `body first frame published (no filler) since_turn_ms=1199` → playout underrun 0 → job closed。

## 3. 稍长连说时 worker 侧会看什么（供你判读，不改参数）

- 唤醒后 4 s 端侧兜底若触发：worker 看 evidence `end_sample − first_sample`（单代总样本，上限 12 s 远未到）与 `trailing_quiet_at_end_ms`（末尾安静时长；被兜底截断时会很短），`finals_held` 是否多段、commit 文本是否完整。
- 稍长句更容易出现「说话中途 ASR 先出一段 final」：看 `speculation on held final` 次数与最终 `using preemptive generation lead_ms`（多段 final 时投机会重启，lead 会变小）。
- 尾段随采即发的锚不变：`end_ms` 应 ≈ 冻结 + 60 ms、`packets_rejected/queue_full_events` 0、`backlog_peak_samples` ≤ 3200 附近。

## 4. 清理与归档

- 含 token 的副本：64.90 `android5.json` / `selfcheck5.json` 已删（目录只剩 `*.public.json` + 注册表），Air 中转副本已删；token 只存在于 Studio 一份，本文与归档无 token、无真实 SN（JWT 前缀正则 0）。
- 仓库归档 `2-Projects/realtime-voice-agent/docs/oneshot-b6-20260909/`：`opcm_poc_rooms_20260911_android5.public.json`、`opcm_poc_rooms_20260911_selfcheck5.public.json`、`opcm_poc_rooms_20260911_registry.txt`（53 条）、`b20_selfcheck_results.jsonl`、`poc_journal_selfcheck5_20260911.log.txt`。

署名：cc（Claude）| 2026-09-11 08:30 CST
