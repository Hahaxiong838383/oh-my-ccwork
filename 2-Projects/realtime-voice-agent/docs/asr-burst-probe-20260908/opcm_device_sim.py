#!/usr/bin/env python3
"""One-shot v0.3 POC 设备模拟器（codex GO 2026-09-08 §2）。

- 铸 token 与 P003 服务端 device-session 同形（iss=API key、sub=dev-<SN>、video grants、roomConfig.agents[0]{agentName, metadata}），
  metadata 多一项 `input_mode: "ordered_pcm"`（受信来源=签发方，不是设备自述）。**token 不打印不落盘。**
- 进 `sn-<测试SN>-<秒>` 房，发布静音麦轨（让 worker 输入门打开），在 topic `p003.audio.history.v1` 上按 OPCM 线格式
  发 begin / chunk(640 样本) / end；收 ack/result；收 control(session.input_ready 等)、state(speaking)、字幕、agent 音频（计回复时长）。
- 场景：positive / missing_chunk(跳过 seq 3) / cancel_mid(发一半后走 control cancel)。
- 不执行任何 MCU 动作；只用合成 wav；测试 SN 不是现役设备。
运行位置：64.90 `/root/voice-venv/bin/python`（livekit 1.1.9 / livekit-api 1.1.1）。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import time
import uuid
import wave
from pathlib import Path

from livekit import api, rtc
from livekit.api import RoomAgentDispatch, RoomConfiguration

TOPIC = "p003.audio.history.v1"
MAGIC = b"OPCM"
VERSION = 1
SR = 16000
ENV_FILES = ("/root/realtime-voice-agent/.env", "/root/realtime-voice-agent/poc-eou.env", "/root/rust-worker/rust-worker.env")


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for f in ENV_FILES:
        p = Path(f)
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().removeprefix("export ").strip()
            if k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                env[k] = v
    return env


def encode(header: dict, pcm: bytes = b"") -> bytes:
    h = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return MAGIC + struct.pack(">HH", VERSION, len(h)) + h + pcm


def decode(raw: bytes) -> tuple[dict, bytes] | None:
    if len(raw) < 8 or raw[:4] != MAGIC:
        return None
    ver, hl = struct.unpack(">HH", raw[4:8])
    if ver != VERSION or len(raw) < 8 + hl:
        return None
    return json.loads(raw[8:8 + hl].decode("utf-8")), raw[8 + hl:]


def read_wav(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2, "need 16k/mono/s16"
        return w.readframes(w.getnframes())


class Sim:
    def __init__(self, a, env):
        self.a = a
        self.env = env
        self.events: list[dict] = []
        self.t0 = time.monotonic()
        self.room = rtc.Room()
        self.trace_id = str(uuid.uuid4())
        self.session_id = str(uuid.uuid4())
        self.input_id = str(uuid.uuid4())
        self.room_name = f"sn-{a.sn}-{int(time.time())}"
        self.identity = f"dev-{a.sn}"
        self.result: dict | None = None
        self.acks: list[dict] = []
        self.input_ready = False
        self.speaking: list[tuple[float, bool]] = []
        self.transcripts: list[dict] = []
        self.control: list[dict] = []
        self.reply_frames = 0
        self.reply_nonzero_frames = 0
        self.reply_samples = 0
        self.done = asyncio.Event()

    def log(self, ev: str, **kw):
        rec = {"t_ms": round((time.monotonic() - self.t0) * 1000), "wall": time.strftime("%H:%M:%S"), "ev": ev, **kw}
        self.events.append(rec)
        print(json.dumps(rec, ensure_ascii=False), flush=True)

    def token(self) -> str:
        meta = json.dumps({"trace_id": self.trace_id, "session_id": self.session_id, "issue_ts_ms": int(time.time() * 1000),
                           "input_mode": "ordered_pcm"})
        t = (api.AccessToken(self.env["LIVEKIT_API_KEY"], self.env["LIVEKIT_API_SECRET"])
             .with_identity(self.identity)
             .with_grants(api.VideoGrants(room_join=True, room=self.room_name, can_publish=True, can_subscribe=True, can_publish_data=True))
             .with_room_config(RoomConfiguration(agents=[RoomAgentDispatch(agent_name=self.a.agent, metadata=meta)]))
             .with_ttl(__import__("datetime").timedelta(minutes=10)))
        return t.to_jwt()

    async def run(self) -> dict:
        a = self.a
        room = self.room

        @room.on("data_received")
        def on_data(pkt: rtc.DataPacket):
            topic = pkt.topic or ""
            if topic == TOPIC:
                d = decode(pkt.data)
                if not d:
                    self.log("history.bad_packet", n=len(pkt.data)); return
                h, body = d
                if h.get("t") == "ack":
                    self.acks.append(h); self.log("history.ack", **{k: h.get(k) for k in ("received_next", "queued_next", "credit_samples", "chunks_received", "phase")})
                elif h.get("t") == "result":
                    self.result = h; self.log("history.result", **h)
                    if h.get("status") in ("failed", "rejected"):
                        # 失败即可收尾(等 1 s 看有没有幽灵回复)
                        asyncio.get_event_loop().call_later(1.5, self.done.set)
                else:
                    self.log("history.other", t=h.get("t"))
            elif topic == "control":
                try:
                    j = json.loads(pkt.data.decode("utf-8"))
                except Exception:
                    self.log("control.bad", n=len(pkt.data)); return
                self.control.append(j)
                kind = j.get("type")
                self.log("control", type=kind, src=j.get("src"), seq=j.get("seq"))
                if kind == "session.input_ready":
                    self.input_ready = True
            elif topic == "state":
                try:
                    j = json.loads(pkt.data.decode("utf-8"))
                except Exception:
                    return
                if j.get("k") == "speaking":
                    self.speaking.append((round((time.monotonic() - self.t0) * 1000), bool(j.get("speaking"))))
                    self.log("state.speaking", speaking=j.get("speaking"))
                    if j.get("speaking") is False and self.result and self.result.get("status") == "complete":
                        asyncio.get_event_loop().call_later(0.8, self.done.set)
            else:
                self.log("data.other", topic=topic, n=len(pkt.data))

        @room.on("transcription_received")
        def on_tr(segments, participant, publication):
            for s in segments:
                rec = {"identity": getattr(participant, "identity", "?"), "final": bool(s.final), "text": s.text}
                self.transcripts.append(rec)
                self.log("transcription", **rec)

        @room.on("track_subscribed")
        def on_track(track, publication, participant):
            self.log("track_subscribed", kind=str(track.kind), identity=participant.identity)
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                asyncio.ensure_future(self.drain_reply(track))

        @room.on("participant_connected")
        def on_pc(p):
            self.log("participant_connected", identity=p.identity)

        self.log("connect", room=self.room_name, identity=self.identity, agent=a.agent, trace_id=self.trace_id, input_id=self.input_id, scenario=a.scenario)
        await room.connect(self.env["LIVEKIT_URL"], self.token(), options=rtc.RoomOptions(auto_subscribe=True))
        self.log("connected")
        # 静音麦轨(让 worker 用户轨订阅→输入门开→pipeline 起)
        source = rtc.AudioSource(SR, 1)
        track = rtc.LocalAudioTrack.create_audio_track("mic", source)
        await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        self.log("mic_published")
        silence_task = asyncio.ensure_future(self.push_silence(source))

        pcm = read_wav(Path(a.wav))
        n = len(pcm) // 2
        chunk = a.chunk_samples
        base = {"input_id": self.input_id, "trace_id": self.trace_id, "session_id": self.session_id,
                "capture_epoch": 1, "wake_generation": 1, "keep_from": a.keep_from, "boundary_kind": a.boundary,
                "overlaps_local_playback": False, "sr": SR, "ch": 1, "fmt": "s16le"}

        async def send(h: dict, body: bytes = b""):
            h = {**h, "sent_at_ms": int(time.time() * 1000)}
            await room.local_participant.publish_data(encode(h, body), reliable=True, topic=TOPIC)

        await asyncio.sleep(a.begin_delay)
        await send({**base, "t": "begin", "seq": 0, "start": 0, "end": 0})
        self.log("history.begin", samples=n)
        seq = 0
        off = 0
        sent = 0
        while off < n:
            m = min(chunk, n - off)
            if a.scenario == "missing_chunk" and seq == a.skip_seq:
                self.log("history.chunk_skipped", seq=seq, start=off, end=off + m)
            else:
                await send({**base, "t": "chunk", "seq": seq, "start": off, "end": off + m}, pcm[off * 2:(off + m) * 2])
                sent += m
            seq += 1
            off += m
            if a.scenario == "cancel_mid" and off >= n // 2:
                self.log("history.cancel_via_control", at_sample=off)
                env = {"trace_id": self.trace_id, "ts_ms": int(time.time() * 1000), "src": "android", "type": "cancel",
                       "lane": "L1", "seq": 1, "payload": {}}
                await room.local_participant.publish_data(json.dumps(env).encode("utf-8"), reliable=True, topic="control")
                break
            if a.pace_ms:
                await asyncio.sleep(a.pace_ms / 1000)
        if a.scenario != "cancel_mid":
            await send({**base, "t": "end", "seq": seq, "start": n, "end": n})
            self.log("history.end", end=n, chunks_sent=seq, samples_sent=sent)
        try:
            await asyncio.wait_for(self.done.wait(), timeout=a.timeout)
        except asyncio.TimeoutError:
            self.log("timeout")
        silence_task.cancel()
        await room.disconnect()
        summary = {
            "scenario": a.scenario, "room": self.room_name, "trace_id": self.trace_id, "input_id": self.input_id,
            "samples_in_wav": n, "chunks_sent": seq, "samples_sent": sent,
            "input_ready": self.input_ready, "acks": len(self.acks),
            "last_ack": self.acks[-1] if self.acks else None, "result": self.result,
            "transcripts_final": [t["text"] for t in self.transcripts if t["final"]],
            "speaking": self.speaking,
            "reply_audio_ms": round(self.reply_samples * 1000 / 48000) if self.reply_samples else 0,
            "reply_nonzero_frames": self.reply_nonzero_frames, "reply_frames": self.reply_frames,
            "control_types": [c.get("type") for c in self.control],
        }
        self.log("summary", **summary)
        return summary

    async def push_silence(self, source: rtc.AudioSource):
        frame = rtc.AudioFrame.create(SR, 1, SR // 100)  # 10 ms 零样本
        while True:
            await source.capture_frame(frame)
            await asyncio.sleep(0.01)

    async def drain_reply(self, track):
        stream = rtc.AudioStream(track)
        async for ev in stream:
            f = ev.frame
            self.reply_frames += 1
            self.reply_samples += f.samples_per_channel
            data = memoryview(f.data).cast("h")
            if any(abs(x) > 50 for x in data[: min(len(data), 480)]):
                self.reply_nonzero_frames += 1


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sn", default="POCTEST0001")
    ap.add_argument("--agent", default="rust-worker-poc")
    ap.add_argument("--wav", required=True)
    ap.add_argument("--scenario", default="positive", choices=["positive", "missing_chunk", "cancel_mid"])
    ap.add_argument("--chunk-samples", type=int, default=640)
    ap.add_argument("--skip-seq", type=int, default=3)
    ap.add_argument("--keep-from", type=int, default=0)
    ap.add_argument("--boundary", default="kws_tail")
    ap.add_argument("--begin-delay", type=float, default=0.3)
    ap.add_argument("--pace-ms", type=float, default=0.0)
    ap.add_argument("--timeout", type=float, default=25.0)
    ap.add_argument("--out", default="opcm_sim_results.jsonl")
    a = ap.parse_args()
    env = load_env()
    for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        if not env.get(k):
            print("missing env", k, file=sys.stderr); return 2
    sim = Sim(a, env)
    summary = await sim.run()
    with open(a.out, "a", encoding="utf-8") as fo:
        fo.write(json.dumps({"summary": summary, "events": sim.events}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
