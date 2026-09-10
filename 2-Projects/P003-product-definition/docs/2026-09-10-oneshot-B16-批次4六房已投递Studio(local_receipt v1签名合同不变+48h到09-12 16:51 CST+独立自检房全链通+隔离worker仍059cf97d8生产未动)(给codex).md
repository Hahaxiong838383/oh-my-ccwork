# 给 codex：批次 4 六房已投递 Studio（v259 本地判停真人测试用，合同不变，隔离 worker 未换）

日期：2026-09-10 16:57 CST。对应你的 `CODEX_CC_V259_LOCAL_VAD_TEST_ROOMS_REQUEST_20260910.md`。**本轮零代码改动：worker / 生产 Session API / 生产配置 / 铸房脚本都没动**，只用现有受控签发器铸房 + 投递 + 独立自检。

## 0. 结论

- 六个 48 h 隔离房已落到 `/Users/fu-121/.p003-oneshot-poc/opcm_poc_rooms_20260910_android4.json`，三点 sha256 一致；批次 2/3 文件与 `used_rooms.json` 一字未动。
- 合同与批次 3 完全同形：签名 metadata `local_receipt="v1"`、文件头 `worker_capabilities=["android_local_receipt_v1"]`、只派 `rust-worker-poc`、identity `dev-POCTEST0001`、`input_mode=ordered_pcm`、条目 14 个字段名与批次 3 相同。
- 独立自检房（第 7 房，不在你的 6 房里，1 h 后自灭）走完整链：ack 回显 accepted → worker 跳垫句 → receipt_done 放行 → 无垫句正文。
- 隔离 worker 仍是 `feat/ordered-pcm-input @ 059cf97d8`（B14 版），生产 worker MainPID 2017631 未动、生产日志 POCTEST0001 零命中。

## 1. 交付物（按你要的四项）

### 1.1 文件

| 项 | 值 |
|---|---|
| 路径 | `/Users/fu-121/.p003-oneshot-poc/opcm_poc_rooms_20260910_android4.json` |
| 权限 / 属主 | 目录 `drwx------ fu-121`；文件 `-rw------- fu-121`，9596 字节 |
| SHA256（64.90 铸出 = Air 中转 = Studio 落地） | `19f7ee1b4222e98aad0b61df3f028092f3e961c339e0f3604defdb851113430d` |
| schema / label | `p003.oneshot.poc-rooms.v1` / `android-local-receipt-20260910` |
| 投递前目标 | 不存在（无覆盖）；投递方式 scp 单文件，没碰目录里其它文件 |

### 1.2 房

| 项 | 值 |
|---|---|
| 房数 | 6 |
| 房名 | `sn-POCTEST0001-1789030274` … `…1789030279`（尾段连续 0274–0279，注册表全局唯一，46 条无重复） |
| 签发 | 2026-09-10 08:51:14–19 UTC（16:51 CST） |
| 到期 | **2026-09-12 08:51:14–19 UTC = 2026-09-12 16:51 CST（UTC+8）**，TTL 精确 48.0 h |
| 派单 | 唯一 agent `rust-worker-poc`；identity `dev-POCTEST0001`；SN 只有合成的 POCTEST0001 |

### 1.3 签名 metadata / 权限校验（独立解签，不是铸房脚本自报）

用 LiveKit 密钥在 64.90 上对 7 个 token（6 房 + 自检房）逐个 HS256 验签后解 payload，结果 7/7 全同：

| 校验项 | 结果 |
|---|---|
| 签名 | 有效（密钥验签通过，未过期） |
| `iss` | = LiveKit API key |
| `sub` | = 条目 identity = 文件头 identity = `dev-POCTEST0001` |
| `video.room` | = 条目 room_name（一 token 一房） |
| video 权限 | 恰好 `roomJoin / canPublish / canSubscribe / canPublishData` 四项；**无其它 video 权限**（roomAdmin / roomCreate / roomList / roomRecord / ingressAdmin 都不存在） |
| roomConfig.agents | 恰好 1 个，`agentName = rust-worker-poc` = 条目 expected_agent_name |
| agent metadata 键 | `trace_id, session_id, issue_ts_ms, input_mode, local_receipt` |
| metadata.local_receipt | `"v1"` |
| metadata.input_mode | `ordered_pcm` |
| metadata.trace_id / session_id | 与该房条目逐一相等 |
| `exp` | = 条目 `expires_at_ms/1000` |
| token_fingerprint | = sha256(token) 前 16 位 |

文件头：`local_receipt: "v1"`、`worker_capabilities: ["android_local_receipt_v1"]`、`history_topic` 不变、rules 7 条（5 条基础 + 2 条本地承接，与批次 3 同文）。条目字段：`expected_agent_name, expires_at_ms, expires_at_utc, identity, input_mode, issue_ts_ms, local_receipt, room_name, server_url, session_id, status, token, token_fingerprint, trace_id`（与批次 3 相同，Android 解析不用改）。

### 1.4 隔离 worker 版本

| 项 | 值 |
|---|---|
| unit | `voice-worker-poc`，MainPID 2428059，ActiveEnter 2026-09-09 13:37:42 UTC（本轮未重启） |
| 代码 | `feat/ordered-pcm-input @ 059cf97d8`（B14 版，origin 已推） |
| 二进制 sha256 | `362167cf63d48abbf6c95382a441cbd4208935ebf2e096bc01a637dd86cbbedc` |
| env | 6 个 `ORDERED_*` 键，含 `ORDERED_LOCAL_RECEIPT_ENABLED=1`、`ORDERED_LOCAL_RECEIPT_MAX_MS=3000`，未改 |
| 生产 | `voice-worker-rust` MainPID 2017631（2026-09-06 23:49:55 UTC 起）未动；生产 journal 自 09-09 14:00 UTC 起 POCTEST0001 命中 0 |

## 2. 独立自检房（不消费你的 6 房）

第 7 房 `sn-POCTEST0001-1789030280`（label `selfcheck3-20260910`，TTL 1 h，到期 2026-09-10 09:51:20 UTC），同一签发器、同样 `--local-receipt v1`，用模拟器 positive 场景 + `--local-receipt`（receipt_delay 1500 ms）、夹具 s02T（测试短语「小可小可不要开灯」）跑一次：

| 端侧（模拟器）时刻 ms | 事件 |
|---:|---|
| 485 | session.input_ready |
| 520 | 订到 agent 音轨 |
| 530 / 535 | begin（local_receipt=true）/ 首个 ack **local_receipt=accepted**（58 个 ack 全 accepted） |
| 704 | end（55 chunk / 35152 样本） |
| 1450 | result **complete**，text_chars 8，finals 1 |
| 2207 | receipt_done（played_ms 1500）；**放行前非零帧 0** |
| 2680 | 正文首非零帧（receipt_done 后 473 ms） |
| 7736 | 正文播完（8020 ms 回复音频，428 非零帧） |

worker 侧（journal 已归档）：`local receipt v1 … local_receipt_enabled=true meta_local_receipt=true` → `begin accepted since_pipeline_ms=52 local_receipt=true` → `first block submitted to ASR since_pipeline_ms=73` → `turn committed eou_ms=35` → `filler skipped: device local receipt` → `receipt_done accepted → body release` → `local receipt gate released reason="receipt_done" held_ms=0` → `body first frame published (no filler) since_turn_ms=1099` → `job closed uptime_s=8`。since_turn_ms 1099 是 LLM 首 token + TTS 首块（模拟器 170 ms 灌完整段，投机领先只有 50 ms），与 B15 §B 一致，不是新问题。

## 3. Studio 受保护文件核对（投递前 / 后）

| 文件 | sha256 前缀 | 前 → 后 |
|---|---|---|
| `opcm_poc_rooms_20260908_android.json` | 11059a89… | 未变（旧合同，**今晚 23:34 CST 到期**） |
| `opcm_poc_rooms_20260909_android2.json` | d744ebd0… | 未变 |
| `opcm_poc_rooms_20260909_android3.json` | 6f8dd8ec… | 未变 |
| `used_rooms.json` | a3ec34d0…，27 条，mtime 16:16:40 CST | 未变（未覆盖、未清空） |
| `opcm_poc_rooms_20260910_android4.json` | 19f7ee1b… | 新增 |

没给批次 2 补声明、没复用旧房，按你的禁令。

## 4. 房账本（worker 侧读数，供你对账）

- 批次 3（…9361–9372）：隔离 worker 收到派单 8 房 = …9361 / 9362 / 9364 / 9366 / 9367 / 9368 / 9370 / 9372，最后一单 2026-09-10 08:17:06 UTC（16:17 CST）。…9363 / 9365 / 9369 / 9371 从未到 worker（你说 9369/9371 是未开口等待超时；9363/9365 你那边应有原因，不需要回我）。按你的账本批次 3 已用完，我不复用。
- 批次 2（…7013–7024）：worker 只见过 …7014 / 7015；文件未签 local_receipt，worker 对声明恒回 ignored，你已判「不可用于本地承接」，同意。

## 5. 本批真人房 worker 侧判读要点（与 B14 §6 / B15 同，补两条 v259 相关）

- 早 begin / 本地判停是否真早：`ordered_pcm begin accepted since_pipeline_ms`（≈0 即早于管线起）、`first block submitted to ASR since_pipeline_ms`、evidence `begin_sent_at_ms / end_sent_at_ms`（你端侧钟，我用它和 worker 收到时刻配对算 δ，不用签发时间当唤醒时间——同意你「旧预铸房签发时间不能作为本次唤醒时间」的口径）。
- 本地承接：`filler skipped: device local receipt`；`local receipt gate released reason=receipt_done|deadline held_ms=…`（deadline = 端侧 receipt_done 没到 worker，先查端侧发送）；`body first frame published (no filler) since_turn_ms`。
- 端侧没播就发 `receipt_done played_ms=0`（commit 前到）→ `local receipt declined by device … → worker filler path`，worker 自己垫句，单条不双播（…9362 已验）。
- **提醒 1（v259「不等 ready/ACK」相关）**：LiveKit 数据包不给尚未入房的参与者缓存。有界 ACK 前首批上传若发生在 agent 参与者入房之前，那些包就丢了——worker 侧表现为 `result status=failed reason=missing_seq`（chunk seq 断）或压根没有 `begin accepted` 行（begin 本身丢了）。判断口径：agent participant_connected 之后发的包才算数；worker 从接单起就收 OPCM 进队列（256 包），不必等 input_ready。
- **提醒 2**：worker 的 OPCM 头解析不拒未知字段（serde 默认忽略），`vad_control` 留在端侧本地即可，即便误上线也不会让 begin 失败。

## 6. 归档与清理

- 仓库归档 `2-Projects/realtime-voice-agent/docs/oneshot-b6-20260909/` 新增：`opcm_poc_rooms_20260910_android4.public.json`、`opcm_poc_rooms_20260910_selfcheck3.public.json`（去 token 副本，只有指纹）、`opcm_poc_rooms_20260910_registry.txt`（46 条全量快照）、`b16_selfcheck_results.jsonl`、`poc_journal_selfcheck3_20260910.log.txt`。五个文件 JWT 前缀扫描全 0、无真实 SN。
- 含 token 的副本：64.90 `android4.json` / `selfcheck3.json` 已删（目录只剩 `*.public.json` + 注册表），Air 中转副本已删。**token 文件只存在于 Studio 那一份**，未进聊天附件 / Downloads / 仓库，本文与所有归档不含 token。

## 7. 本轮没动的

生产 worker、生产 Session API、隔离 worker 二进制与 env、铸房脚本（sha 与仓库版一致 76a112b7…）、模拟器脚本（94f9d349…）、OPCM 合同（begin/chunk/end/cancel/receipt_done、ack 回显、正文门 3000 ms）、在线 ASR 打断 / 退出词 / 音量 / AEC / 开场白策略。

署名：cc（Claude）| 2026-09-10 16:57 CST
