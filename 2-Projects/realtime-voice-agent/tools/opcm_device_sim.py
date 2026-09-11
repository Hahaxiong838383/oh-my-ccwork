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
        self.pre_token: str | None = None
        self.server_url: str | None = None
        self.room_source = "minted"
        if getattr(a, "room_file", None):
            # 预铸房模式：条目字段与生产 device-session 响应同名；本进程不读任何 LIVEKIT 密钥
            doc = json.loads(Path(a.room_file).read_text(encoding="utf-8"))
            e = doc["rooms"][a.room_index]
            self.room_name, self.identity = e["room_name"], e["identity"]
            self.trace_id, self.session_id = e["trace_id"], e["session_id"]
            self.pre_token, self.server_url = e["token"], e["server_url"]
            self.room_source = f"file#{a.room_index}"
            if e.get("expected_agent_name") and e["expected_agent_name"] != a.agent:
                a.agent = e["expected_agent_name"]
        self.result: dict | None = None
        self.acks: list[dict] = []
        self.input_ready = False
        self.speaking: list[tuple[float, bool]] = []
        self.transcripts: list[dict] = []
        self.control: list[dict] = []
        self.reply_frames = 0
        self.reply_nonzero_frames = 0
        self.reply_samples = 0
        # 本地承接 v1：正文门验收用——首个非零回复帧时刻 / receipt_done 发出前的非零帧数（期望 0）/ end 与 receipt_done 时刻
        self.first_nonzero_t_ms: int | None = None
        self.nonzero_before_receipt = 0
        self.receipt_sent_t_ms: int | None = None
        self.end_t_ms: int | None = None
        # B23 产品首句 v1：首句终态后同房切 RTC——第二句经 mic 轨真实推流；session.input_phase 事件；RTC 阶段的用户 final
        self.rtc_queue = bytearray()
        self.rtc_push_t_ms: int | None = None
        self.rtc_end_t_ms: int | None = None
        self.input_phase_events: list[dict] = []
        self.first_reply_done_t_ms: int | None = None
        self.done = asyncio.Event()

    def t_ms(self) -> int:
        return round((time.monotonic() - self.t0) * 1000)

    def log(self, ev: str, **kw):
        rec = {"t_ms": round((time.monotonic() - self.t0) * 1000), "wall": time.strftime("%H:%M:%S"), "ev": ev, **kw}
        self.events.append(rec)
        print(json.dumps(rec, ensure_ascii=False), flush=True)

    def token(self) -> str:
        if self.pre_token:
            return self.pre_token
        # B23：--rtc-only-meta = 生产同款 metadata（无 input_mode）→ 普通 RTC 房回归；--first-turn-meta = 签 oneshot_first_turn v1
        if self.a.rtc_only_meta:
            meta = json.dumps({"trace_id": self.trace_id, "session_id": self.session_id, "issue_ts_ms": int(time.time() * 1000)})
        else:
            meta = json.dumps({"trace_id": self.trace_id, "session_id": self.session_id, "issue_ts_ms": int(time.time() * 1000),
                               "input_mode": "ordered_pcm",
                               **({"local_receipt": "v1"} if self.a.local_receipt_meta else {}),
                               **({"oneshot_first_turn": "v1"} if self.a.first_turn_meta else {})})
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
                    self.acks.append(h); self.log("history.ack", **{k: h.get(k) for k in ("received_next", "queued_next", "credit_samples", "chunks_received", "phase", "end_candidate", "local_receipt")})
                elif h.get("t") == "result":
                    self.result = h; self.log("history.result", **h)
                    if h.get("status") in ("failed", "rejected") and not self.a.rtc_wav:
                        # 失败即可收尾(等 1 s 看有没有幽灵回复)；B23 带 --rtc-wav 时失败后还要验切 RTC，不收尾
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
                if kind == "session.input_phase":
                    pl = j.get("payload") or {}
                    self.input_phase_events.append({"t_ms": self.t_ms(), **pl})
                    self.log("control.input_phase", reason=pl.get("reason"), phase=pl.get("phase"), ordered=pl.get("ordered"),
                             stt_spawned_ms_ago=pl.get("stt_spawned_ms_ago"))
            elif topic == "state":
                try:
                    j = json.loads(pkt.data.decode("utf-8"))
                except Exception:
                    return
                if j.get("k") == "speaking":
                    self.speaking.append((round((time.monotonic() - self.t0) * 1000), bool(j.get("speaking"))))
                    self.log("state.speaking", speaking=j.get("speaking"))
                    if j.get("speaking") is False:
                        if self.first_reply_done_t_ms is None:
                            self.first_reply_done_t_ms = self.t_ms()
                        if self.a.rtc_wav:
                            if self.rtc_end_t_ms is not None:
                                asyncio.get_event_loop().call_later(0.8, self.done.set)
                        elif self.result and self.result.get("status") == "complete":
                            asyncio.get_event_loop().call_later(0.8, self.done.set)
            else:
                self.log("data.other", topic=topic, n=len(pkt.data))

        @room.on("transcription_received")
        def on_tr(segments, participant, publication):
            for s in segments:
                rec = {"identity": getattr(participant, "identity", "?"), "final": bool(s.final), "text": s.text, "t_ms": self.t_ms()}
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
        await room.connect(self.server_url or self.env["LIVEKIT_URL"], self.token(), options=rtc.RoomOptions(auto_subscribe=True))
        self.log("connected")
        # 静音麦轨(让 worker 用户轨订阅→输入门开→pipeline 起)
        source = rtc.AudioSource(SR, 1)
        track = rtc.LocalAudioTrack.create_audio_track("mic", source)
        await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        self.log("mic_published")
        silence_task = asyncio.ensure_future(self.push_mic(source))

        pcm = read_wav(Path(a.wav))
        if a.wav_head_ms > 0:
            pcm = pcm[: (SR * a.wav_head_ms // 1000) * 2]  # B23：只发头部（纯唤醒词回归）
        n = len(pcm) // 2
        chunk = a.chunk_samples
        # B25：--session-mismatch 让包头 session_id 与签发 metadata 不同（token 里仍是真值）
        wire_session = ("mismatch-" + self.session_id[8:]) if a.session_mismatch else self.session_id
        base = {"input_id": self.input_id, "trace_id": self.trace_id, "session_id": wire_session,
                "capture_epoch": 1, "wake_generation": 1, "keep_from": a.keep_from, "boundary_kind": a.boundary,
                "overlaps_local_playback": False, "sr": SR, "ch": 1, "fmt": "s16le"}

        async def send(h: dict, body: bytes = b""):
            h = {**h, "sent_at_ms": int(time.time() * 1000)}
            await room.local_participant.publish_data(encode(h, body), reliable=True, topic=TOPIC)

        await asyncio.sleep(a.begin_delay)
        seq = 0
        off = 0
        sent = 0
        if a.no_begin:
            # B23：端侧没走首句（旧客户端/开关关）——不发任何 OPCM，期望 worker begin 超时后切 RTC
            self.log("history.no_begin")
            n = 0
        else:
            await send({**base, "t": "begin", "seq": 0, "start": 0, "end": 0, **({"local_receipt": True} if a.local_receipt else {})})
            self.log("history.begin", samples=n)
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
        # B25 end 锚：负偏移 = 先推第二句再发 end（RTC 帧早于 end 到达 worker）
        if a.rtc_wav and a.rtc_at == "end" and a.rtc_offset_ms < 0:
            await self.push_rtc_utterance("end-early")
            await asyncio.sleep(-a.rtc_offset_ms / 1000)
        if a.scenario != "cancel_mid" and not a.no_begin:
            await send({**base, "t": "end", "seq": seq, "start": n, "end": n})
            self.end_t_ms = self.t_ms()
            self.log("history.end", end=n, chunks_sent=seq, samples_sent=sent)
        # B25 end 锚：非负偏移 = end 发送后 N ms 推第二句（与切换/STT2 建连交错）
        if a.rtc_wav and a.rtc_at == "end" and a.rtc_offset_ms >= 0:
            if a.rtc_offset_ms:
                await asyncio.sleep(a.rtc_offset_ms / 1000)
            await self.push_rtc_utterance("end-late")
        # 本地承接 v1：模拟端侧本地短语播完 → receipt_done（-1 = 永不发，验截止放行；cancel_mid 也发，验取消后不复活）
        if a.local_receipt and a.receipt_delay_ms >= 0 and not a.no_begin:
            await asyncio.sleep(a.receipt_delay_ms / 1000)
            await send({**base, "t": "receipt_done", "seq": seq + 1, "start": n, "end": n, "played_ms": a.receipt_delay_ms})
            self.receipt_sent_t_ms = self.t_ms()
            self.log("history.receipt_done", played_ms=a.receipt_delay_ms, nonzero_before=self.nonzero_before_receipt)
        if a.rtc_wav and a.rtc_at == "connect":
            if a.rtc_offset_ms:
                await asyncio.sleep(a.rtc_offset_ms / 1000)
            await self.push_rtc_utterance("connect")
        if a.rtc_wav and a.rtc_at == "phase":
            # B23：首句终态（result / input_phase）后，等首答播完（有的话）再经 mic 轨真实推第二句
            if a.no_begin:
                ok = await self.wait_until(lambda: bool(self.input_phase_events), 8.0)
                self.log("rtc.gate", waited_for="input_phase", ok=ok)
            else:
                ok = await self.wait_until(lambda: self.result is not None, 15.0)
                self.log("rtc.gate", waited_for="result", ok=ok, outcome=(self.result or {}).get("outcome"))
                if ok and (self.result or {}).get("outcome") == "task":
                    ok2 = await self.wait_until(lambda: self.first_reply_done_t_ms is not None, 15.0)
                    self.log("rtc.gate", waited_for="first_reply_done", ok=ok2)
            await asyncio.sleep(a.rtc_delay_ms / 1000)
            await self.push_rtc_utterance("phase")
        try:
            await asyncio.wait_for(self.done.wait(), timeout=a.timeout)
        except asyncio.TimeoutError:
            self.log("timeout")
        silence_task.cancel()
        await room.disconnect()
        summary = {
            "scenario": a.scenario, "room": self.room_name, "trace_id": self.trace_id, "input_id": self.input_id,
            "room_source": self.room_source,
            "samples_in_wav": n, "chunks_sent": seq, "samples_sent": sent,
            "input_ready": self.input_ready, "acks": len(self.acks),
            "last_ack": self.acks[-1] if self.acks else None, "result": self.result,
            "transcripts_final": [t["text"] for t in self.transcripts if t["final"]],
            "speaking": self.speaking,
            "reply_audio_ms": round(self.reply_samples * 1000 / 48000) if self.reply_samples else 0,
            "reply_nonzero_frames": self.reply_nonzero_frames, "reply_frames": self.reply_frames,
            "control_types": [c.get("type") for c in self.control],
            "local_receipt": bool(a.local_receipt), "receipt_delay_ms": a.receipt_delay_ms if a.local_receipt else None,
            "ack_local_receipt": next((x.get("local_receipt") for x in reversed(self.acks) if x.get("local_receipt")), None),
            "end_t_ms": self.end_t_ms, "receipt_sent_t_ms": self.receipt_sent_t_ms,
            "first_nonzero_t_ms": self.first_nonzero_t_ms, "nonzero_before_receipt": self.nonzero_before_receipt,
            "result_outcome": (self.result or {}).get("outcome"), "result_next": (self.result or {}).get("next"),
            "input_phase_events": self.input_phase_events,
            "rtc_at": a.rtc_at, "rtc_offset_ms": a.rtc_offset_ms,
            "rtc_push_t_ms": self.rtc_push_t_ms, "rtc_end_t_ms": self.rtc_end_t_ms,
            "rtc_push_minus_end_ms": (self.rtc_push_t_ms - self.end_t_ms) if (self.rtc_push_t_ms is not None and self.end_t_ms is not None) else None,
            "rtc_user_finals": [t["text"] for t in self.transcripts if t["final"] and t["identity"] == self.identity and self.rtc_push_t_ms is not None and t["t_ms"] >= self.rtc_push_t_ms],
            "user_finals_all": [t["text"] for t in self.transcripts if t["final"] and t["identity"] == self.identity],
            "speaking_starts": sum(1 for _, sp in self.speaking if sp),
            "first_nonzero_after_end_ms": (self.first_nonzero_t_ms - self.end_t_ms) if (self.first_nonzero_t_ms is not None and self.end_t_ms is not None) else None,
            "first_nonzero_after_receipt_ms": (self.first_nonzero_t_ms - self.receipt_sent_t_ms) if (self.first_nonzero_t_ms is not None and self.receipt_sent_t_ms is not None) else None,
        }
        self.log("summary", **summary)
        return summary

    async def push_mic(self, source: rtc.AudioSource):
        """mic 轨：默认 10 ms 零样本；B23 队列里有 RTC 语音时按实时节拍推真实样本（第二句/无 begin 回归用）。"""
        n = SR // 100
        zero = rtc.AudioFrame.create(SR, 1, n)
        pushing = False
        while True:
            if len(self.rtc_queue) >= n * 2:
                chunk = bytes(self.rtc_queue[: n * 2]); del self.rtc_queue[: n * 2]
                frame = rtc.AudioFrame.create(SR, 1, n)
                memoryview(frame.data).cast("B")[:] = chunk
                await source.capture_frame(frame)
                pushing = True
            else:
                if pushing:
                    pushing = False
                    self.rtc_end_t_ms = self.t_ms()
                    self.log("rtc.utterance_end")
                await source.capture_frame(zero)
            await asyncio.sleep(0.01)

    async def push_rtc_utterance(self, tag: str):
        """B25：把第二句塞进 mic 队列（push_mic 按实时节拍推）。锚/偏移由调用方决定。"""
        rtc_pcm = read_wav(Path(self.a.rtc_wav))
        self.rtc_queue.extend(rtc_pcm)
        self.rtc_push_t_ms = self.t_ms()
        self.log("rtc.utterance_start", samples=len(rtc_pcm) // 2, wav=Path(self.a.rtc_wav).name, anchor=tag,
                 offset_ms=self.a.rtc_offset_ms)

    async def wait_until(self, pred, timeout_s: float) -> bool:
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout_s:
            if pred():
                return True
            await asyncio.sleep(0.05)
        return False

    async def drain_reply(self, track):
        stream = rtc.AudioStream(track)
        async for ev in stream:
            f = ev.frame
            self.reply_frames += 1
            self.reply_samples += f.samples_per_channel
            mv = memoryview(f.data)
            data = mv if mv.format == "h" else mv.cast("h")  # livekit-rtc 1.1.x 已是 int16 视图，cast 会抛 TypeError
            if any(abs(x) > 50 for x in data[: min(len(data), 480)]):
                self.reply_nonzero_frames += 1
                if self.first_nonzero_t_ms is None:
                    self.first_nonzero_t_ms = self.t_ms()
                    self.log("reply.first_nonzero")
                if self.receipt_sent_t_ms is None:
                    self.nonzero_before_receipt += 1


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
    ap.add_argument("--room-file", default="", help="预铸房 JSON（opcm_poc_mint_rooms.py 输出）；给定则不读 LIVEKIT 密钥")
    ap.add_argument("--room-index", type=int, default=0)
    ap.add_argument("--local-receipt", action="store_true", help="本地承接 v1：begin 带 local_receipt=true（期望 ack 回显 accepted，worker 不播垫句、扣正文到 receipt_done）")
    ap.add_argument("--receipt-delay-ms", type=int, default=1500, help="end 后多少 ms 发 receipt_done（模拟本地短语时长）；-1 = 永不发（验截止放行）")
    ap.add_argument("--local-receipt-meta", action="store_true", help="自铸 token 的 metadata 签 local_receipt=v1（不给则 worker 应回 ignored）")
    ap.add_argument("--first-turn-meta", action="store_true", help="B23：自铸 token 的 metadata 签 oneshot_first_turn=v1（首句终态后 worker 切 RTC）")
    ap.add_argument("--rtc-only-meta", action="store_true", help="B23：自铸 token 只签 trace/session/issue_ts（生产同款，无 input_mode）→ 普通 RTC 房回归")
    ap.add_argument("--no-begin", action="store_true", help="B23：不发任何 OPCM（端侧没走首句）→ 期望 worker begin 超时切 RTC")
    ap.add_argument("--rtc-wav", default="", help="B23：首句终态/首答后经 mic 轨真实推的第二句 wav（16k mono s16le）")
    ap.add_argument("--rtc-delay-ms", type=int, default=1500, help="B23：推第二句前的等待（首答播完后计）")
    ap.add_argument("--session-mismatch", action="store_true",
                    help="B25：begin/chunk 头的 session_id 故意与签发 metadata 不一致（验 worker 消息级 rejected/session_mismatch）")
    ap.add_argument("--rtc-at", default="phase", choices=["phase", "end", "connect"],
                    help="B25：第二句推送锚——phase=等首句 result/相位切换(默认)；end=与 end 发送交错(验采样边界)；connect=进房即推")
    ap.add_argument("--rtc-offset-ms", type=int, default=0,
                    help="B25：相对 --rtc-at 锚的偏移；end 锚下负值 = 先推第二句再发 end（制造 RTC 早于 end 到达）")
    ap.add_argument("--wav-head-ms", type=int, default=0, help="B23：只发 OPCM wav 的前 N ms（纯唤醒词回归）")
    a = ap.parse_args()
    if a.room_file:
        env: dict[str, str] = {}
    else:
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
