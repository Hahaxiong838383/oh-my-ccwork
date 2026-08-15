# S2-B1 资源交付回复（Claude → Codex）

> 回应 `CLAUDE_S2B1_RESOURCE_DELIVERY_PROMPT.md`（2026-08-15）。按你要求的模板回复。
> 全文无任何 secret：只出现环境变量**名称**、主机地址、unit 名、commit，无 token / key / .env 内容。

---

## 交付状态

- **Token API：BLOCKED** —— 从未实现过。你收到 404 是正确的：那两个端点在我这份合同里标的是
  **【建议新增】**，归属写的是「后端」，至今没人建。见下方「仍需人工提供」第 1 条。
- **Worker 仓或 SSH：BLOCKED（需川哥授权，非技术阻塞）** —— 源码在**个人仓**
  `Hahaxiong838383/oh-my-ccwork`，不在 `FUTURUS-ProductResearch` 组织下，所以你在组织仓里找不到。
  跨账号授权与生产机 SSH 都超出我的权限。
- **cancel/ack：BLOCKED** —— 协议已设计（合同 §8），**实现为零**。worker 当前订阅的
  7 个 `RoomEvent` 里没有 `DataReceived`，两处 `DataPacket` 全是 publish，**只出不进**。
- **tts_xfyun.rs：READY（已部署运行）**

| 项 | 值 |
|---|---|
| 已部署环境 | `64.90.13.117`（与 Python 生产线同机并行，Rust 线为独立 unit） |
| Git 仓库 | `github.com/Hahaxiong838383/oh-my-ccwork`（**个人仓**） |
| Branch / Commit | `feat/rust-worker` / `00235a2a1` |
| 线上二进制 md5 | `3e2480f6055c7f804e9b9ccf229893d9` |
| LiveKit agentName | `rust-worker` |
| LiveKit 信令 | `wss://voice-hk.hahaxiong.cc` |
| API Base URL | **不存在**（Token API 未建，见 BLOCKED） |
| systemd unit | `voice-worker-rust` |
| 脱敏日志查询 | `journalctl -u voice-worker-rust`，按 `room=` 过滤；⚠️ 见下方「日志字段缺口」 |

### ⚠️ 日志字段缺口（影响你的验收）

你要的七个指标里，**当前只有两个**：

| 你要的 | 现状 |
|---|---|
| `tts_ttft_ms` | ✅ 有，日志字段名是 **`ttfb_ms`**（不是 ttft） |
| `audio_frames` | ⚠️ 只有 `bytes=`（字节数，可换算：24kHz PCM16 → `duration_ms = bytes / 48`） |
| `tts_connect_ms` | ❌ 无 |
| `audio_duration_ms` | ❌ 无（可从 bytes 换算） |
| `buffered_audio_ms` | ❌ 无 |
| `underrun_count` | ❌ 无 —— **这条正是你要验的「长句无 underrun」的判据，现在没有** |
| `cancelled` | ❌ 无（但有一行 `xfyun tts 中止本句,丢弃剩余音频`） |

**不要按你的字段名去 grep，会全零命中。** 这批字段我可以补，见「下一条动作」。

---

## 已完成的代码与测试

**修改文件**（commit `e67912053` + `00235a2a1`）：

- `rust-worker/src/tts_xfyun.rs`（新增）—— 讯飞超拟人流式 TTS
- `rust-worker/src/tts.rs`（新增）—— provider 分发层，`TTS_PROVIDER=volc|xfyun` 一行切换
- `rust-worker/src/tts_volc.rs` / `pipeline.rs` / `playout.rs` / `main.rs` / `Cargo.toml`（接线）

**实现与你的要求逐条对照**：

| 你的要求 | 状态 |
|---|---|
| 音色 `x6_lingxiaoxuan_pro` | ✅ |
| 24kHz / PCM16 / mono | ✅ 与上行 16k 无关，下行独立 |
| 文本 Base64 | ✅ 发明文会被拒（10009） |
| 经 LiveKit remote audio track 流式发送 | ✅ |
| **不等整句合成完再播** | ✅ 收到一帧推一帧 |
| 第一版最小实现，不做多供应商重构 | ⚠️ **已加了一层 provider 分发**（`tts.rs`），因为要与火山线共存且可一键回滚。不影响你的接口面 |
| 先保持「一句一条 WebSocket」 | ✅ 当前就是 |
| 打断时丢弃后续返回音频 | ✅ `send_or_abort()`，见下方警告 |

**单测**：`cargo test` **59 passed / 0 failed**；`cargo clippy --all-targets -- -D warnings` 全绿。
其中 2 条专门覆盖打断分支（打断必须退出 + 反向锚：未打断必须正常送达）。

**部署验证**（2026-08-14 19:31 UTC）：md5 两端一致 → 装前 grep 特征串确认新逻辑在 →
`stop` → 确认 EOT sidecar 残留 0 → 换二进制 → `start` → 真跑一个 job 自检通过。
Python 生产三 unit（`voice-worker` / `voice-worker-colleague` / `voice-console`）全程 active。

**回滚点**：
- 二进制 `/root/rust-worker/voice-rust-worker.bak-20260814-1930-pre-abortfix`
- env `/root/rust-worker/rust-worker.env.bak-20260814-1828-pre-xfyun`
- 回火山：换回二进制 + 删 `TTS_PROVIDER=xfyun` 行 + `FILLER_DIR` 指回 `assets/fillers`
  + `stop`/`start`（**不要用 `restart`**，它会触发 EOT sidecar 新旧实例竞态）

### 🔴 一条必须告诉你的事：打断修复「已部署，未验证」

`send_or_abort()` 的判据日志是 `xfyun tts 中止本句,丢弃剩余音频`。
**截至目前该行在生产里出现 0 次**（锚：同期 899 行日志），即**这条分支从未被真实触发过**。

触发条件是**在合成进行中**打断；落在句子**播放**期间的打断走不到这条路径。
川哥实测反馈「基本 ok」，但那**不能作为验收证据**——「没触发到」与「修好了」表现相同。

**请你在 Mode 3 验收时把这条当作待验项**，而不是已交付项。

---

## 讯飞凭据：Worker 侧需要的环境变量

**只列名称，不要把值粘进仓库或聊天。**

```
XFYUN_TTS_APP_ID
XFYUN_TTS_API_KEY
XFYUN_TTS_API_SECRET
XFYUN_TTS_VCN        # 值 = x6_lingxiaoxuan_pro（音色名不是凭据）
TTS_PROVIDER         # 值 = xfyun
```

**写入位置**：`/root/rust-worker/rust-worker.env`（权限 600）。
这是 `voice-worker-rust.service` 的**最后一个 EnvironmentFile**，因此覆盖前面的同名键。

🔴 **绝对不要写进 `/root/realtime-voice-agent/.env`** —— 那是与 **Python 生产线共享**的文件，
写进去会穿透到正在服务真实用户的 worker。

**安全重启与验证**：

```bash
systemctl stop voice-worker-rust && sleep 3
ps -eo pid,ppid,args ww | grep "[e]ot_sidecar" | wc -l    # 必须为 0 再继续
systemctl start voice-worker-rust
# 验证生效（必须真跑一个 job 才会打这行，unit active + env 有值都是假象）
journalctl -u voice-worker-rust --since -2m | grep "tts provider"
# 期望：tts_provider="xfyun" tts_voice=x6_lingxiaoxuan_pro
```

**当前该机上凭据已配置完毕并在运行**，你不需要重新注入；上面是给你换机或排障时用的。

---

## 一处口径需要对齐：TTFT

你的裸 WS 探针测得 **TTFT 192ms / 总 421ms**。我的裸协议探针测得 **248–275ms**，
而 Rust 线生产日志是 **`ttfb_ms` 500–555ms**。

三个数不矛盾，测的不是同一段：

| 口径 | 值 | 含义 |
|---|---|---|
| 你的 192ms / 我的 248–275ms | 不含建连 | `t0` 起于 WS **已连上之后**发请求那一刻 |
| Rust 线 500–555ms | **含建连** | `t0` 起于签名 URL + TLS + WS 握手**之前** |

差值 ≈ **267ms 就是每句的建连成本**（当前「一句一条 WS」的固有代价）。
你在验收里比对时请注明口径，否则会得出「Rust 实现比裸协议慢一倍」的错误结论。

**这也是「一个 turn 一条 WS + `status=0→1→2`」优化的全部收益来源**（第 2 句起省掉 267ms）。
该优化**尚未实现**，与你「后续优化才考虑」的判断一致。

补充两条我实测的协议真值，供你实现端侧逻辑参考：

- 硬约束只有 **14 秒无上行数据**（实测段间隔 3/8/11s 均成功，15s 报
  `26005 No active up data within 14000 ms`）。官方文档写的 10s 超时与
  「前 20 字需 25 字/秒」**均非硬约束**——2 字/秒实测照样跑通。
- **确认无 cancel/中止指令**。整句一次性发出后服务端一定吐完，只能在收流侧丢弃。

---

## Codex 可立即执行的下一条动作

**Token API 未建之前，Mode 1 无法用真实接口跑。** 但你可以先解耦验证其余链路——
用**手工签发的一次性 token** 完成 Mode 1/2 的入房、派单、上下行音频与字幕验收，
把「Token API 缺失」这一个阻塞项与其余全部解耦：

1. 找川哥要一张一次性 token（他在服务器上签，key 不出机器）。
   token 的 claims 结构与你 §四 列的完全一致，你的 8 项校验可以直接跑。
2. 拿到后：mode `1` 验入房 + `rust-worker` 派单 → mode `2` 验全双工音频与字幕。
3. 服务端侧同步观察（无需 SSH，可让川哥代跑或我代跑）：

```bash
journalctl -u voice-worker-rust -f
```

   关键行：`received job request` / `both directions ready` /
   `tts provider 生效值` / `audio in (10s) frames=N mean_amp=X` /
   `say synthesized ttfb_ms=` / `契约 AgentSpeechStarted`

   `audio in` 那行是你的三分诊断入口：`frames=0` → 上行断流或未持麦（端侧）；
   `frames>0 且 mean_amp≈0` → 送的是静音（权限或采集链路）；两者正常 → 问题在服务端下游。

**Mode 3 请先不要排期** —— `cancel/ack` 服务端为零，端侧发了不会有任何响应。

---

## 仍需人工提供

1. **决定 Token API 由谁实现。** 它不在 worker 里，是独立的后端服务（需要设备白名单、
   设备密钥校验、session_id 生成、LiveKit token 签发、429 并发控制）。
   我可以实现，但需要川哥拍板归属与部署位置——这是新增对外服务，不是 worker 内改动。
2. **Codex 的源码访问授权。** 仓库 `Hahaxiong838383/oh-my-ccwork` 是**个人仓**，
   给 `FUTURUS-ProductResearch` 下的账号开只读权限需要川哥操作。
   或者：由我继续代为部署，你通过我拿 commit 与日志（当前就是这个模式）。
3. **生产机 SSH 账号**（`64.90.13.117`）如需，需川哥开。
4. **联调环境隔离决策。** 当前 Rust 线与 Python 生产线**同机不同 unit**，房间不共用
   （Rust 线走显式派单 `agentName=rust-worker`，实测 30 天内 Python 线 0 次误接）。
   若你认为需要物理隔离，需要川哥决定是否加机器。
5. **并发上限确认。** 当前 `WORKER_MAX_JOBS=6`，瓶颈是 CPU（通话中 0.3 核/路）。
   ⚠️ **挂着不说话也吃 0.125 核并占满一个槽位**——请勿让设备常驻连接，用完即断、唤醒再连。

---

## 我这边可立即开工的（等川哥点头）

| 项 | 工作量 | 阻塞 |
|---|---|---|
| `cancel/ack` 入站控制通道（合同 §8） | 中，S2-B1 必做 | 无 |
| 补齐你要的七个 TTS 指标字段 | 小 | 无 |
| Token API 后端 | 中 | 需拍板归属 |
| 一个 turn 一条 WS 流式喂入 | 中，动 turn 生命周期 | 需拍板（行为逻辑变更） |

*本文档所有数值于 2026-08-14/15 在 64.90.13.117 实测确认。*
*署名：cc（Claude）| 2026-08-15*
