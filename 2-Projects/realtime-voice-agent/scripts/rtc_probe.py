"""RTC probe:真 LiveKit 房间端到端验证 client(Studio loopback 跑)。

用途(验 Tier A cascade 真 session,非离线 Fake):
  - normal:喂真人中文 wav + 补静音 → 验 turn detector(v1-mini) 语义判停 + STT→LLM→TTS 闭环
  - noise :喂真人 wav 触发 agent 回复,回复期注入白噪声段 → 验 agent_false_interruption 契约
    (噪声过 VAD 0.5s 阈值但非语音 sherpa 识别不出 → 2s 内无 final transcript → false interrupt)

连 ws://127.0.0.1:7880(devkey/secret),dispatch agent_name=realtime-voice-agent。
真跑取证用,看 worker 日志判 turn detector init / 契约事件;本脚本可选录 agent 回复 wav。

API 依据(2026-06-24 .venv 实测签名,no-guessing):
  api.AccessToken(key,secret).with_identity().with_grants(api.VideoGrants(...)).to_jwt()
  rtc.AudioSource(sr,1) / rtc.LocalAudioTrack.create_audio_track(name,source)
  rtc.AudioFrame(data,sr,1,samples)            # 每帧 new,不复用(复用喂 silero 数据无效)
  api.LiveKitAPI(http,key,secret).agent_dispatch.create_dispatch(CreateAgentDispatchRequest(...))
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time
import wave

import numpy as np
from livekit import api, rtc

_VOICE_AMP = 300.0  # PCM16 mean-abs 有声判定阈值(说话 ~1000+,静音 <200)


def _amp(arr: np.ndarray) -> float:
    return float(np.abs(arr.astype(np.int32)).mean()) if len(arr) else 0.0

# 自动加载项目根 .env(#32 修:免手动 source,token 从 .env 读真实 KEY 而非默认 devkey→401)
# setdefault=不覆盖外部已 export 的值(外部 source 优先)
_ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
if os.path.exists(_ENV):
    for _ln in open(_ENV):
        _ln = _ln.strip()
        if "=" in _ln and not _ln.startswith("#"):
            _k, _v = _ln.split("=", 1)
            os.environ.setdefault(_k, _v)

# .env 有 LIVEKIT_URL/KEY/SECRET 则用之(上面已自动加载);否则 loopback + devkey 占位
WS = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
HTTP = WS.replace("wss://", "https://").replace("ws://", "http://")
KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")
AGENT = "realtime-voice-agent"


def load_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = w.readframes(n)
    pcm = np.frombuffer(raw, dtype=np.int16)
    if ch > 1:
        pcm = pcm.reshape(-1, ch)[:, 0].copy()
    return pcm, sr


def make_noise(seconds: float, sr: int, amp: int = 9000) -> np.ndarray:
    """白噪声:能量过 VAD 阈值但非语音(sherpa 出不了文本)→ 触发 false interruption。"""
    rng = np.random.default_rng(7)
    return (rng.standard_normal(int(seconds * sr)) * amp).astype(np.int16)


async def feed(
    source: rtc.AudioSource,
    pcm: np.ndarray,
    sr: int,
    voice_state: dict[str, float | None] | None = None,
) -> None:
    """逐 10ms 帧喂入。每帧 new AudioFrame;capture_frame 内置按帧节流,无需额外 sleep。"""
    step = max(1, sr // 100)
    for i in range(0, len(pcm), step):
        chunk = pcm[i : i + step]
        if len(chunk) < step:
            chunk = np.pad(chunk, (0, step - len(chunk)))
        if voice_state is not None and _amp(chunk) > _VOICE_AMP:
            voice_state["t_last_voice"] = time.monotonic()  # 端到端计时锚:最后有声帧
        frame = rtc.AudioFrame(
            data=chunk.tobytes(),
            sample_rate=sr,
            num_channels=1,
            samples_per_channel=len(chunk),
        )
        await source.capture_frame(frame)


async def main(a: argparse.Namespace) -> None:
    token = (
        api.AccessToken(KEY, SECRET)
        .with_identity("probe")
        .with_grants(
            api.VideoGrants(
                room_join=True, room=a.room, can_publish=True, can_subscribe=True
            )
        )
        # token 内嵌 agent dispatch:join 即触发 worker(同 web 页路径,不改 worker)
        .with_room_config(
            api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=AGENT)])
        )
        .to_jwt()
    )
    room = rtc.Room()
    rec_frames: list[bytes] = []
    rec_sr = 0
    # 端到端首声计时:t_last_voice=喂入的最后有声帧;armed 后首个 agent 有声帧=用户体感首响
    voice_state: dict[str, float | None] = {
        "t_last_voice": None,
        "t_first_reply": None,
        "armed": None,
    }

    @room.on("track_subscribed")
    def _on_track(track: rtc.Track, *_: object) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            asyncio.create_task(_pull(track))

    @room.on("data_received")
    def _on_data(data: rtc.DataPacket) -> None:
        try:
            print(f"[probe] metric: {bytes(data.data).decode()}", flush=True)
        except Exception:
            pass

    async def _pull(track: rtc.Track) -> None:
        nonlocal rec_sr
        async for ev in rtc.AudioStream(track):  # type: ignore[arg-type]
            rec_sr = ev.frame.sample_rate
            buf = bytes(ev.frame.data)
            rec_frames.append(buf)
            if voice_state["armed"] is not None and voice_state["t_first_reply"] is None:
                arr = np.frombuffer(buf, dtype=np.int16)
                if _amp(arr) > _VOICE_AMP:
                    voice_state["t_first_reply"] = time.monotonic()
                    tlv = voice_state["t_last_voice"]
                    if tlv is not None:
                        dt_ms = (voice_state["t_first_reply"] - tlv) * 1000
                        print(
                            f"[probe] ★ 端到端首声 +{dt_ms:.0f}ms"
                            "(停说→agent 出声,filler 开时含承接音)",
                            flush=True,
                        )

    if a.relay:
        # 强制 ICE 走 TURN 中继:验证 TURN/TLS 全链路(大陆→境外跨境 UDP 被 QoS 掐时的兜底路径)
        opts = rtc.RoomOptions(
            rtc_config=rtc.RtcConfiguration(
                ice_transport_type=rtc.IceTransportType.TRANSPORT_RELAY
            )
        )
        await room.connect(WS, token, options=opts)
    else:
        await room.connect(WS, token)
    print(f"[probe] connected room={a.room} relay={a.relay}", flush=True)

    print(f"[probe] joined, agent dispatch via room config (agent={AGENT})", flush=True)

    pcm, sr = load_wav(a.wav)
    # queue_size_ms 默认 1000:capture_frame 提前 ~1s 返回 → t_last_voice 虚早,端到端
    # 首声虚高 ~1s(2026-07-02 实测 4381 vs 真实 ~2500)。压到 100ms 让喂帧≈实时。
    source = rtc.AudioSource(sr, 1, queue_size_ms=100)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    print(f"[probe] published mic sr={sr} samples={len(pcm)}", flush=True)

    await asyncio.sleep(a.warmup)  # 等 agent join + greeting + AEC warmup(3s)过
    print("[probe] 喂真人问句 + 补静音(触发 endpoint 判停)...", flush=True)
    await feed(source, pcm, sr, voice_state)
    voice_state["armed"] = time.monotonic()  # 问句喂完,此后 agent 首个有声帧=首响
    await feed(source, np.zeros(int(1.5 * sr), dtype=np.int16), sr)

    if a.noise > 0:
        await asyncio.sleep(a.noise_delay)  # 等 agent 进入回复(说话期)
        base = pcm[: int(a.noise * sr)]
        if a.lowvol:
            # 低音量真人(探针实测 silero 仍判语音 prob1.0 但 sherpa 出空):
            # SOS→pause agent + 无 final→2s timer→false interruption。
            seg = (base // 10).astype(np.int16)
            label = "低音量真人语音"
        elif a.voiced:
            seg = base[::-1].copy()  # reversed:silero 判语音但 sherpa 出乱字→多为真打断
            label = "reversed 真人语音"
        else:
            seg = make_noise(a.noise, sr)  # 白噪声(探针实测 silero 不判语音 prob<0.03)
            label = "白噪声"
        print(f"[probe] 注入 {a.noise}s {label}(验 false interruption)...", flush=True)
        await feed(source, seg, sr)
        await feed(source, np.zeros(int(2.5 * sr), dtype=np.int16), sr)  # 静默等 timer(2s)

    await asyncio.sleep(a.listen)
    if a.record and rec_frames and rec_sr:
        with wave.open(a.record, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rec_sr)
            w.writeframes(b"".join(rec_frames))
        print(f"[probe] 录 agent 回复 → {a.record} ({rec_sr}Hz)", flush=True)
    elif a.record:
        print("[probe] 未录到 agent 音频", flush=True)

    await room.disconnect()
    print("[probe] done", flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--wav", required=True)
    p.add_argument("--room", default="probe-room")
    p.add_argument("--warmup", type=float, default=6.0, help="喂音频前等待(agent join+warmup)")
    p.add_argument("--listen", type=float, default=14.0, help="喂完后等 agent 回复秒数")
    p.add_argument("--noise", type=float, default=0.0, help=">0 注入该秒数噪声验 false interruption")
    p.add_argument("--voiced", action="store_true", help="注入 reversed 真人语音(silero 判语音)而非白噪声")
    p.add_argument("--lowvol", action="store_true", help="注入低音量真人语音(silero 判语音但 STT 出空→false interrupt)")
    p.add_argument("--noise-delay", type=float, default=1.5, help="喂完问句后多久注入噪声")
    p.add_argument("--record", default="", help="订阅 agent track 录 wav 路径")
    p.add_argument("--relay", action="store_true", help="强制 ICE 走 TURN 中继(验证跨境兜底)")
    asyncio.run(main(p.parse_args()))
