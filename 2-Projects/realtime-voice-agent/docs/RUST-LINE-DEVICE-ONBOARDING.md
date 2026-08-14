# Rust 灰度线 · 设备接入 prompt（自研通道）

> 用途：把一台**自研设备**接进 Rust 重写版 worker 的房间。整份文档可直接转交给做设备端集成的人/agent。
> 参数全部为 2026-08-14 线上实测，非推断。与子贤的 demo 线（Python tenant unit）互不影响。

---

## 0. 一句话说清接入模型

> 设备只做三件事：**进房 → 发布麦克风轨 → 播放 agent 的音轨**。
> ASR / 判停 / 打断 / LLM / TTS / 字幕全在服务端，设备侧没有任何 AI 逻辑。

派单不靠房间名，也不靠设备做任何调用：**agent dispatch 内嵌在 token 里**，设备拿这张 token 进房，Rust worker 自动被派进同一个房间。

---

## 1. 已验证参数（照抄，勿改写）

| 项 | 值 | 验证方式 |
|---|---|---|
| 信令地址 | `wss://voice-hk.hahaxiong.cc` | worker 进程 env 实读 |
| agent 名（派单标识） | `rust-worker` | 同上；unit 描述同名 |
| 派单机制 | token 的 `roomConfig.agents[].agentName` | 线上测试页 token claims 解出 |
| 房间名 | 任意，设备自定；**约定 `sn-<SN>-<时间戳>`** | probe 用时间戳房名实测 |
| 设备身份 | participant identity = **`dev-<SN>`**（埋点归因唯一数据源） | 见 `RUST-LINE-TELEMETRY-PLAN.md` |
| **并发上限** | **同时 2 个房间**（`WORKER_MAX_JOBS=2`） | worker 进程 env 实读 |
| 上行音频 | 任意常规采样率，SDK 自动重采样；worker 按 **16kHz 单声道**取流 | `job.rs` 取流参数 |
| 下行音频 | 24kHz 单声道（服务端已编码为 opus） | TTS 采样率常量 |
| 字幕通道 | **legacy Transcription 数据包**（非 text stream） | `transcript_pub.rs` 实现 |

⚠️ **不要按房间名区分线路**。Python 主线是自动派单（无 agent 名），Rust 线是显式派单。实测 30 天内 Python 线 0 次接到 Rust 房间的单（同期它处理了 8078 条房间/任务日志作为对照锚，证明这个 0 不是"日志没信号"）——**token 里带了显式 dispatch，自动派单会被抑制，不会两个 AI 同时进房**。

---

## 2. 签 token（API key 不出服务器）

在 **64.90.13.117** 上执行；key 从服务器 env 读，全程不落地、不进 git、不发聊天工具。

```bash
ssh root@64.90.13.117
cd /root/realtime-voice-agent && set -a && . ./.env && set +a
ROOM="dev-001-$(date +%s)"
/root/voice-venv/bin/python -c '
import os,sys,datetime
from livekit import api
room=sys.argv[1]
print(api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
  .with_identity("dev-<SN>").with_name("dev-<SN>")   # ← SN 走 identity,埋点靠它归因
  .with_grants(api.VideoGrants(room_join=True, room=room,
      can_publish=True, can_subscribe=True, can_publish_data=True))
  .with_room_config(api.RoomConfiguration(
      agents=[api.RoomAgentDispatch(agent_name="rust-worker")]))
  .with_ttl(datetime.timedelta(days=30)).to_jwt())
' "$ROOM"
echo "房间: $ROOM"
```

签完必须核对 claims（缺 `roomConfig` 这一段 = 设备能进房但**永远等不到 AI**，且没有任何报错，是这条链路最难查的失败形态）：

```bash
# 把 <TOKEN> 换成上一步输出，只解 payload 不碰签名
python3 -c 'import sys,base64,json;p=sys.argv[1].split(".")[1];p+="="*(-len(p)%4);print(json.dumps(json.loads(base64.urlsafe_b64decode(p)),ensure_ascii=False,indent=2))' <TOKEN>
```

正确形状（已实测）：

```json
{
  "video": { "roomJoin": true, "room": "dev-001-…", "canPublish": true,
             "canSubscribe": true, "canPublishData": true },
  "roomConfig": { "agents": [ { "agentName": "rust-worker" } ] },
  "iss": "voicekey", "exp": 1789279091
}
```

- **TTL 30 天**，到期重签（到期后设备端表现为连不上信令）。
- **一房一 token**：token 里的 `room` 是锁死的，换房间必须重签。
- token 等同房间钥匙：**不进 git、不写进固件明文、不贴聊天工具**。设备量产要走服务端下发。

---

## 3. 设备端实现（平台无关）

用 LiveKit **官方客户端 SDK**（覆盖 Web / iOS / Android / Flutter / Unity / Rust / Python / Go / 嵌入式，具体清单以 `docs.livekit.io` 为准，别自己撸信令）。

```text
1. connect(wss://voice-hk.hahaxiong.cc, <token>)
2. 发布本地麦克风音轨          ← 必须，agent 靠它听
3. 订阅远端参与者的音轨并播放   ← agent 的声音（远端参与者即 rust-worker）
4. 监听 transcription 事件     ← 字幕，见 §4
5. 断线重连交给 SDK，别自己重建房间
```

不需要设备做：VAD、判停、打断判定、静音检测、轮次管理。**这些服务端全做了**；设备端再做一层会和服务端的打断门控互相打架。

---

## 4. 字幕：必须订阅 legacy Transcription 通道

服务端走的是 **legacy `publish_transcription` 数据包**，不是 `lk.transcription` 文本流。SDK 里对应的是 room 级 `TranscriptionReceived` / `transcription_received` 事件，回调拿到 segment 列表。

| 字段 | 含义 |
|---|---|
| `text` | 字幕文本 |
| `final` | `false`=中间态（同一 `id` 会被后续包整句覆盖）；`true`=定稿后换新 `id` |
| 包上的 participant | **被转写者**：用户句 = 用户 identity；AI 句 = agent identity。靠它分左右气泡 |

- AI 侧字幕**按播出位置逐句发**（进入播出=interim，播完/被打断=final），所以字幕跟着声音走。
- 被打断那一轮的 final 文本 = **实际播出的截断部分**，不是完整生成文本。这是正确行为，别当 bug。

⚠️ 用错通道的后果是**静默的**：订阅 text stream 收不到任何东西，也不报错，看起来就像"服务端没做字幕"。上一轮验收就是这么漏的——12 项全绿而字幕功能整个没实现。

---

## 5. 设备端四个必做项

1. **🔴 回声消除（AEC）必须设备自己做。** 服务端只有 0.5s 的"打断抑制窗"，**不是回声消除**。设备如果外放且麦克风能听到自己喇叭，AI 会把自己的声音当成用户插话，**每句都自我打断，表现为"说半句就停"**。浏览器有 WebRTC 内建 AEC 所以看不到这问题，裸设备没有。上硬件 AEC 或系统级 AEC，先验证再接。
2. **麦克风增益别拉太高**。实测增益 ×2.5 不但捞不回弱音，还会把词误识别成别的。
3. **音频播放要低延迟**，缓冲越大打断体感越差（用户已经插话了，喇叭还在放上一句）。
4. **进房前确认已获麦克风权限**，否则表现为"连上了但 AI 一直不说话"，与派单失败同形。

---

## 6. 验收：按通道普查，不是数检查项

**只测你能想到的通道 = 只能发现你能想到的问题。** 逐条确认，缺一条就是盲区，不许记"已验证"：

| 通道 | 期望 | 怎么看 |
|---|---|---|
| ① 上行音频 | worker 收到有声帧 | 服务端日志 `audio in (10s) frames=N mean_amp=X` |
| ② 下行音频 | 设备听到 AI 说话 | 人耳 / 录音 |
| ③ 用户字幕 | 说话后出现用户侧 final | 设备端字幕回调 |
| ④ AI 字幕 | AI 说话时出现 agent 侧 final | 同上 |
| ⑤ 打断 | AI 说话中插话，AI 立刻停 | 人测 |
| ⑥ 会话结束 | 断开后 worker 释放 job | `journalctl` 无残留 job |

服务端侧一条命令看完：

```bash
ssh root@64.90.13.117 'journalctl -u voice-worker-rust -f'
```

---

## 7. 排障（三分诊断，先定位在哪一段）

看 `audio in (10s) frames=N mean_amp=X` 这一行：

| 现象 | 结论 |
|---|---|
| `frames=0` | 上行断流 / 设备息屏 / 麦克风没发布 → **问题在设备侧** |
| `frames>0` 但 `mean_amp≈0` | 送的是静音 → 麦克风权限或采集链路 |
| 两者都正常但 AI 不回 | 问题在服务端下游，抓 `asr:` / `llm` / `tts` 行 |

**已知上游行为（不是 bug，别再查设备）**：火山 ASR 对**孤立单字短指令**（"停"/"好"/"对"）会**整段丢弃**——零中间结果、零定稿、零报错，观测上与"用户根本没说话"完全同形。已上热词缓解，但存在**声学硬底**：信道差或发音轻时仍会丢。设备侧话术建议用**双音节**（"停一下"/"好的"）显著提高存活率。

---

## 8. 红线

- **不要碰 `voice-worker` / `voice-worker-colleague` / `voice-console` 三个 unit**，那是生产线和子贤 demo 线。Rust 线只有 `voice-worker-rust`。
- 并发只有 2 路，设备联调时别和别人抢；要压测提前说。
- token / API key 不进 git、不进固件明文、不发聊天工具。
- 设备端改动后重新跑一遍 §6 全部六条——**上一版验过不等于这一版验过**。

---

*本文所有参数于 2026-08-14 在 64.90.13.117 与 47.239.204.68 实测确认；签发流程已实跑验证 claims 结构正确。*
