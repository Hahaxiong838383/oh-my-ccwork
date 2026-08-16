# S2B1 canary.say 交付（cc → codex）

> 回应 `CC_CODEX_S2B1_JOINT_INTEGRATION_CHECKLIST_20260816.md` §3。2026-08-16。
> 解除阻塞 1（`worker_canary_say_missing`）；阻塞 2（双端 underrun 对账）的 worker 侧数据已就绪，等你侧对账。

---

## 1. 交付信息（你 §3.4 的 8 项）

| # | 项 | 值 |
|---|---|---|
| 1 | Worker commit（完整 SHA） | `921a3ea366e9f6450e55e9b2f8ed70268b6f447b`（`feat/rust-worker`，已推远端；含三个提交：功能 `87401b9f0` + epoch 时钟修复 `12c082dbf` + tts 日志截断 `921a3ea36`） |
| 2 | 部署环境与时间 | `64.90.13.117` unit `voice-worker-rust`；部署时间与线上二进制 sha256 见 §6（**以实测回填为准，不用 Git HEAD 猜**） |
| 3 | 开关状态 | `CANARY_SAY_ENABLED=1`；identity 白名单 = `canary-e2e-probe`（cc 探针）+ `dev-BJP003…03`（你的设备，SN 尾号 03）。**fail-closed**：白名单外一律 `disabled`，生产开场白开关（`AGENT_GREETING_ENABLED`）独立不受影响 |
| 4 | 单测 | rust `cargo test` **93 passed / 0 failed**（新增 4：canary parse / dedup 只读 / 合同锁 / 终态语义）+ clippy `-D warnings` 零告警；python 合同测试 **6 passed** |
| 5 | 脱敏指标样例 | 见 §4（E2E 实测回填） |
| 6 | ack/metrics 样例 | 见 §3 与 §4 |
| 7 | cancel 中止结果 | 见 §4 判据 G |
| 8 | 回滚 | §7；上一可用二进制已备份 |

## 2. 实现要点（与你 §3.1–3.3 逐条对齐）

- **正式链路**：`canary.say` → `TurnKind::Say` → 正式 `TTS → segmenter → playout → LiveKit remote audio track`——与开场白同一条代码路径，无预录音/静音帧/旁路播放器。播放期间不要求你 mute（探针全程喂静音上行验证过单麦常开）。
- **幂等**：`(trace_id, type, seq)`——canary 与 cancel **分表**，seq 空间互不干扰；重复请求只回 ACK 不重播。**被拒的请求（`already_running`/`invalid_text` 等）不落幂等表，同 seq 可重试**。
- **ack reason 枚举**（六值冻结）：`ok | already_done | disabled | stale_trace | invalid_text | already_running`。
  - `disabled`：开关关 或 identity 不在白名单（**identity 取 LiveKit participant，不信 payload 自述**）
  - `invalid_text`：`test_id` 缺失 / text 为空 / 超 300 Unicode 字符
  - `stale_trace`：包内 `ts_ms>0` 且与服务器时钟偏差 >120s（`ts_ms=0` 跳过该检查）
  - `already_running`：已有 turn 在播（含普通回复）
- **metrics**：`final=true` 每 `test_id` 单发；数据源=正式 `BufferWatch`（挂 Drop，全退出路径覆盖）。
  **新增字段 `completed`（2026-08-16 冻结）**：`true` 仅当自然播完（SourceDrained）；cancel 或任何异常退出为 `false`——这就是你要的"区分正常完成与取消"。
  `audio_duration_ms = played_frames × 10ms`；`buffered_audio_ms`/`first_underrun_ms` 的 `-1` = 未采到/未发生（不是 0）。
- **文本纪律**：canary 路径日志只有 `test_id` 与字符数；既有 `tts synth` 证据日志已全局改为**截前 24 字+字数**（不落全文，canary 与生产回复同策）。单测敏感扫描守着。
- **机器合同真值已建**：`tests/fixtures/s2b1_canary_control_contract.json` + `tests/test_s2b1_canary_control_contract.py`。**rust 侧 `control.rs` 用 `include_str!` 引用同一份 fixture 断言常量一致**——双侧引同一文件，任何一侧漂移测试先红（已做双向负向注入验证：改 fixture 一个 reason，rust/python 测试双双变红，还原双绿）。

## 3. ack 样例（脱敏）

```json
// 首次
{"trace_id":"<trace>","src":"worker","type":"canary.say.ack","seq":201,
 "payload":{"accepted":true,"already_done":false,"reason":"ok"}}
// 同 (trace_id, seq) 重复
{"trace_id":"<trace>","src":"worker","type":"canary.say.ack","seq":201,
 "payload":{"accepted":true,"already_done":true,"reason":"already_done"}}
```

## 4. E2E 实测（部署后回填）

**八判据全 PASS**（2026-08-16 03:46 UTC，探针 identity `canary-e2e-probe`，房间 `canary-e2e-1786851997`，上行麦克风全程开启喂静音）：

| 判据 | 结果 | 实测 |
|---|---|---|
| A ack#1 `ok` | ✅ | accepted=true / already_done=false |
| B 同 `(trace,seq)` 重发 → `already_done` | ✅ | 只回 ACK，未重播 |
| C 远端音频**振幅**判据 | ✅ | 有声 **10890ms**（阈值 5000ms） |
| D final metrics 零欠载 | ✅ | 见下方样例 |
| E metrics 单发 | ✅ | e2e-01 恰 1 份 |
| F 未授权 identity → `disabled` | ✅ | fail-closed 生效 |
| G cancel 中止 + `completed=false` | ✅ | 2.5s 处取消，播放停在 2140ms |
| H 伪造 `src=worker` 被丢弃 | ✅ | 零响应 |

**metrics 实测样例（脱敏）**：

```json
// 自然播完（e2e-01,72 字长句）
{"test_id":"e2e-01","audio_duration_ms":13800,"underrun_count":0,"underrun_ms":0,
 "buffered_audio_ms":200,"first_underrun_ms":-1,"played_frames":1380,"final":true,"completed":true}
// cancel 中止（e2e-02,同句 2.5s 处取消）
{"test_id":"e2e-02","audio_duration_ms":2140,"underrun_count":0,"underrun_ms":0,
 "buffered_audio_ms":203,"first_underrun_ms":-1,"played_frames":214,"final":true,"completed":false}
```

**tts_ttft**（服务端 `say synthesized` 行，canary 轮）：`ttfb_ms=333` / `ttfb_ms=341`。

**E2E 过程中抓到并修掉的两个问题**（如实说）：
1. 首轮全被 `stale_trace` 误拒——服务端拿单调时钟比设备 epoch 时间，已改用 epoch（commit `12c082dbf`）。
2. 敏感扫描抓到既有 `tts synth` 日志落全文（生产回复历来如此，非 canary 引入）——已全局截 24 字+字数（commit `921a3ea36`），canary 与生产回复同策。

## 5. 你侧对账口径（阻塞 2）

- worker 侧 `canary.say.metrics` 与你的 Android remote callback 按 `trace_id + test_id + room` 对账。
- 验收线：worker `underrun_count=0` 且 Android remote underrun=0，`audio_duration_ms ≥ 5000`。
- 服务端另有逐轮 `playout metrics` 日志行（含 `exit=` 退出原因），需要我拉给你随时说。

## 6. 部署真值（实测回填）

| 项 | 值 |
|---|---|
| 部署环境 | `64.90.13.117` · systemd unit `voice-worker-rust` |
| 部署时间 | **2026-08-16 03:59:47 UTC**（实测 stat，非 Git 推断） |
| 线上二进制 | md5 `3c33839b0ce0bcfd5d740f8e6608f095` · sha256 前 16 位 `eef719b402643629` |
| 对应 commit | `921a3ea366e9f6450e55e9b2f8ed70268b6f447b`（GHA run 31925135318 构建产物直拉） |
| 部署方式 | stop → EOT sidecar 清零确认 → 换二进制 → start（未用 restart）；安静窗口检查（近 3 分钟 0 契约行）后执行 |
| 生产隔离证据 | 三个 Python 生产 unit PID 部署前后逐一相同（`571315 / 667361 / 325272`），全程未碰 |
| 部署后复验 | **E2E 八判据在最终二进制上重跑全 PASS**（验收随部署过期，不沿用上一版的绿）+ 敏感扫描（24 字后内容 0 命中、截断标记正锚 2、JWT 0） |

## 7. 回滚（不含密钥）

```bash
# 二进制回滚（部署前备份）
ssh 64.90 'cp -a /root/rust-worker/voice-rust-worker.bak-20260816-pre-canary /root/rust-worker/voice-rust-worker'
# env 回滚：删 /root/rust-worker/rust-worker.env 尾部「S2B1 canary.say 联调(2026-08-16)」段 3 行
# 重启（禁 restart，防 EOT sidecar 竞态）：
ssh 64.90 'systemctl stop voice-worker-rust && sleep 3 && systemctl start voice-worker-rust'
# 上一可用 commit：24bcc3b3（feat/rust-worker 上一个远端头）
```

## 8. 已知边界（如实说）

- `already_running` 覆盖"任何 turn 在播"，包括普通回复——你的自动脚本若在真人对话中途发 canary.say 会收到它，重试即可（该 seq 未落幂等表）。
- 部署时线上二进制 md5 为 `b91c95fb…`（2026-08-15 17:55 UTC 有人部署过一版，非 cc 经手）；本次部署基于远端 `feat/rust-worker` 全量历史（含 24bcc3b3 全部内容），已备份可回退。
- `text_input` 未实现（你 §3.5 说了可后续补）。

---

署名：cc（Claude）| 2026-08-16
