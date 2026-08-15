# voice-rust-worker：连接后固定开场白已关闭（交接给 codex）

日期：2026-08-15
接收方：codex / P003 安卓端
状态：**DONE / 已部署 / 已验收，可直接跑安卓复验**

---

## 1. 回传清单（按你 §6 的格式）

```text
Worker branch:            feat/rust-worker
Worker commit:            a6fe22491551358899cf5a5b081ba4e2a25b6447
Deployed unit:            voice-worker-rust   （另外三个 unit 未触碰，见 §5）
AGENT_GREETING_ENABLED=0: 已写入 /root/rust-worker/rust-worker.env:19
Unit tests:               89 passed / 0 failed（新增 9 条）+ clippy 零告警 + 4 处负向注入四处红
连接后 TTS request count: 0
连接后 audible PCM ms:    0
用户首轮正常回复:          PASS（stt final → LLM → 4 句 tts synth → 3 条 tts metrics）
cancel regression:        PASS 3/3（首次生效 / 幂等 already_done / 伪造 src=worker 被丢弃）
```

线上二进制 md5：`0b3c771b836ff269eab6cfe6fb28df72`（替换前 `78b07bf5d245bb4a155c0469d90911cc`）

---

## 2. 实现（按你 §4 的规格，一处未偏离）

`PipelineConfig` 增 `greeting_enabled: bool`，从 `AGENT_GREETING_ENABLED` 读，
默认 `true`；启动处由无条件改为门禁：

```rust
let greeting = orch.cfg.greeting_text.clone();
if should_greet(orch.cfg.greeting_enabled, &greeting) {
    orch.start_turn(TurnKind::Say(greeting));
} else {
    info!(room = %room_name, enabled = …, text_empty = …, "开场白已关闭,保持 Listening");
}
```

三点说明：

- **门禁抽成了 `should_greet(enabled, text)` 函数**，不是内联表达式。理由是让单测能直接调用
  生产用的那条判据——在测试里重写一遍条件等于没测它。
- **空文本同样不播**。这不只是防御：Python 侧关闭开场白的既有做法就是把 `AGENT_GREETING`
  置空（`tier_a_cascade` 里 `elif self._settings.agent_greeting:` 落空）。两边现在语义一致，
  你用哪种关法都行。
- **非法布尔值回退默认而不是 panic**。开场白是体验开关不是安全开关，误配不该让 worker 起不来。

关闭路径实测满足你列的全部六条：不建 Say turn、不调讯飞 TTS、不产可听 PCM、
不写 assistant 历史、不发开场白字幕、不影响上行/VAD/ASR/cancel。

---

## 3. 验收数据（全部服务端实测，2026-08-15）

| 场景 | 判据 | 实测 |
|---|---|---|
| 连接后静默 6s | 锚：job connected / user track subscribed / cascade started | 1 / 1 / 1 |
| 同上 | `开场白已关闭` 日志 | 1 |
| 同上 | tts synth / tts metrics / AgentSpeechStarted / playout metrics / filler picked | **0 / 0 / 0 / 0 / 0** |
| 用户说一句 | stt final → tts synth | 转写正确，4 句合成，ttft 277/274/311 ms |
| 连续重连 ×3 | 每次都无开场白、worker 不崩 | 3 锚 / 3 条关闭日志 / tts synth 0 / panic 0 / NRestarts 0 |
| cancel（有效回复播报中途） | cancelled / already_done / 伪造丢弃 | PASS / PASS / PASS |

单测 9 条覆盖你 §4.3 列的五类，另加「全空白文本」与「正例锚」两条。
四处负向注入（忽略开关 / 忽略空文本 / 非法值不回退 / 漏掉 `off` 取值）全部让测试变红，
还原后 md5 与备份逐字节一致——判据是活的，不是恒绿。

---

## 4. ⚠️ 两条会让你误判的坑（请先看这段再跑安卓）

### 4.1 远端音轨仍然有帧，那不是开场白

探针实测：静默 6 秒收到 `remote_audio_frames=574`。**agent 的音频轨照常发布并推流**，
只是里面没有内容。服务端同期 tts synth / playout metrics 全 0。

所以你 Mode 2 的判据「无自动可听 PCM」**必须按幅度判，不能按帧数或轨道存在与否判**。
按帧数判会得到「有 PCM」的假阳性。

### 4.2 用房间名 grep 服务端日志会得到假零

`tts metrics` / `tts synth` / `AgentSpeechStarted` / `契约 *` 这几行**不带 `room=` 字段**
（只有 `job connected` / `turn committed` / `audio in` / `job closed` / `开场白已关闭` 带）。

我第一轮就是按房间名过滤统计的，结论是「TTS 请求 0、用户没被识别」——**全是我自己造的零**，
实际那一轮 ASR、LLM、TTS 全程正常。改用时间窗归因（并先确认窗口内只有目标 job）才拿到真数。

你若要自己对账，用时间窗，不要用房间名。

---

## 5. 部署边界（你 §5 的红线，逐条对账）

只动了 `voice-worker-rust`。另外三个 unit 的 MainPID 部署前后逐一比对，完全相同：

```text
voice-worker            active  pid=571315   （前后一致）
voice-worker-colleague  active  pid=424110   （前后一致）
voice-console           active  pid=325272   （前后一致）
```

- 开关写在 `/root/rust-worker/rust-worker.env`——它是 `voice-worker-rust` 独有的
  最后一个 `EnvironmentFile`，另外两个 worker 不加载它。
- **共享的 `/root/realtime-voice-agent/.env` 未改**（md5 前后一致 `1b836ebc…`）。
  那份里的 `AGENT_GREETING=你好，我在，可以直接打断我。` 原样保留，其他环境行为不变。
- 重启按你的顺序执行：stop → 等 EOT sidecar 清零（实测第 1 次检查即 0）→ 换二进制 → start。
  没有用 `systemctl restart`。部署前先确认了近 90 秒无未闭合 job，没有掐断在途会话。

凭据、token、签名 URL 全程未进 git、未进命令行参数、未进日志（artifact 的签名 URL
经 stdin 传给服务器的 `curl -K`）。

---

## 6. 回滚

```bash
# 只回配置（最快，几秒）
sed -i 's/^AGENT_GREETING_ENABLED=0/AGENT_GREETING_ENABLED=1/' /root/rust-worker/rust-worker.env
systemctl stop voice-worker-rust && systemctl start voice-worker-rust

# 连二进制一起回退
cp /root/rust-worker/voice-rust-worker.bak-78b07bf5 /root/rust-worker/voice-rust-worker
cp /root/rust-worker/rust-worker.env.bak-greeting-20260815 /root/rust-worker/rust-worker.env
systemctl stop voice-worker-rust && systemctl start voice-worker-rust
```

安卓 APK 不需要回退。

---

## 7. 一处如实说明

cancel 那轮，服务端 `xfyun tts 中止本句` 计数为 **0**：取消落在两句之间，
而不是某句合成进行中。**turn 级取消确实生效**（ack 回 `cancelled=true`，后续无新合成），
只是没有正在合成的句子被中断。ack 是契约判据，这条 PASS 成立；
但如果你 Mode 3 要专门验「合成中途被打断」，需要把 cancel 时机卡进单句合成窗口。

另：本次只解决「连接后固定 TTS」。你 §8 提的 `canary.say` 长句 AEC、正式 Session API、
同房双端 underrun、旧在线 Runtime 重拿麦，都不在本次范围，S2-B1 整体不能据此报 READY。

---

署名：cc（Claude）| 2026-08-15
