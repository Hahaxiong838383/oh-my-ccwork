#!/usr/bin/env python3
"""隔离 ASR 输入实验探针（One-shot 历史入口前置，2026-09-08）。

目的：不接真机、不改生产、不用用户录音，只用合成音频，验证「火山 bigmodel_async 二遍链路
+ 当前 worker 的分块/收流形态」在 1x 实时、突发（快于实时）、混合（先突发历史再实时）三种
节奏下的接收与识别行为，并记录取消（中途断流）后是否还有任何 definite 可被消费。

协议逐字段对齐 rust-worker/src/stt_volc.rs（3a2af41c3）：
  - URL：nonstream=1 → ASYNC_ASR_URL(bigmodel_async)，nonstream=0 → 老 bigmodel；
  - 鉴权头：有 VOLC_ASR_API_KEY 走 X-Api-Key，否则 X-Api-App-Id/App-Key/Access-Key；
    X-Api-Resource-Id / X-Api-Request-Id / X-Api-Connect-Id 同形；
  - init payload：model_name=bigmodel, enable_itn/punc=true, enable_ddc=env, show_utterances=true,
    enable_nonstream, end_window_size=env(默认 150)，corpus.context = JSON 字符串 {"hotwords":[{"word":..}]}；
  - 分块：STT_SEGMENT_SAMPLES=3200 样本（200 ms / 6400 B）一帧，AudioOnlyClient+PositiveSeq+gzip；
    输入结束发空载荷 NegativeSeq 收流，只等服务端 LastNoSeq。
帧封装复用 doubao_speech._ws_client 原语（与 rust volc.rs marshal_matches_python_bytes 同源）。

隐私/安全：env 只读 VOLC_* / P003_DEVICE_ASR_HOTWORDS，任何值不打印、不落盘；结果只含合成句文本与标量。
运行位置：64.90 `/root/voice-venv/bin/python`（有 websockets 15 + doubao_speech）。
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import gzip
import json
import re
import struct
import sys
import time
import uuid
import wave
from pathlib import Path

import websockets
from doubao_speech._ws_client import (  # type: ignore[import-not-found]
    Compression,
    Flags,
    Message,
    MsgType,
    Serialization,
    _recv,
    _send,
)

ASYNC_ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
OLD_ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
SR = 16000
STT_SEGMENT_SAMPLES = 3200  # == rust-worker pipeline.rs STT_SEGMENT_SAMPLES
BLOCK_BYTES = STT_SEGMENT_SAMPLES * 2
BLOCK_MS = STT_SEGMENT_SAMPLES * 1000 // SR
ENV_FILES = (
    "/root/realtime-voice-agent/.env",
    "/root/realtime-voice-agent/poc-eou.env",
    "/root/rust-worker/rust-worker.env",
)
_PUNCT = re.compile(r"[\s，。！？!?,.、~～…：:；;\"'“”‘’]")


def load_env(files=ENV_FILES) -> dict[str, str]:
    """按 unit 的 EnvironmentFile 顺序叠层（后者覆盖），只取需要的键，值绝不输出。"""
    keep = {"VOLC_APP_ID", "VOLC_ACCESS_TOKEN", "VOLC_ASR_API_KEY", "VOLC_ASR_RESOURCE_ID",
            "VOLC_ASR_END_WINDOW_MS", "VOLC_ASR_ENABLE_DDC", "VOLC_ASR_HOTWORDS",
            "P003_DEVICE_ASR_HOTWORDS"}
    env: dict[str, str] = {}
    for f in files:
        p = Path(f)
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if k.startswith("export "):
                k = k[7:].strip()
            if k in keep:
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                env[k] = v
    return env


def build_headers(env: dict[str, str], request_id: str) -> dict[str, str]:
    h: dict[str, str] = {}
    key = env.get("VOLC_ASR_API_KEY", "")
    if key:
        h["X-Api-Key"] = key
    else:
        h["X-Api-App-Id"] = env.get("VOLC_APP_ID", "")
        h["X-Api-App-Key"] = env.get("VOLC_APP_ID", "")
        h["X-Api-Access-Key"] = env.get("VOLC_ACCESS_TOKEN", "")
    h["X-Api-Resource-Id"] = env.get("VOLC_ASR_RESOURCE_ID", "volc.bigasr.sauc.duration")
    h["X-Api-Request-Id"] = request_id
    h["X-Api-Connect-Id"] = str(uuid.uuid4())
    return h


def hotword_list(env: dict[str, str], use: str) -> list[str]:
    if use == "none":
        return []
    raw = ",".join(x for x in (env.get("VOLC_ASR_HOTWORDS", ""), env.get("P003_DEVICE_ASR_HOTWORDS", "")) if x)
    seen: list[str] = []
    for w in raw.split(","):
        w = w.strip()
        if w and w not in seen:
            seen.append(w)
    return seen


def build_init_payload(env: dict[str, str], request_id: str, nonstream: bool, end_window: int, hotwords: list[str]) -> dict:
    request: dict = {
        "model_name": "bigmodel",
        "enable_itn": True,
        "enable_punc": True,
        "enable_ddc": env.get("VOLC_ASR_ENABLE_DDC", "1") == "1",
        "show_utterances": True,
        "enable_nonstream": nonstream,
        "end_window_size": end_window,
    }
    if hotwords:
        request["corpus"] = {"context": json.dumps({"hotwords": [{"word": w} for w in hotwords]}, ensure_ascii=False)}
    return {
        "user": {"uid": request_id},
        "audio": {"format": "pcm", "codec": "raw", "rate": SR, "bits": 16, "channel": 1},
        "request": request,
    }


def read_wav_16k_mono(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        if w.getframerate() != SR or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit(f"{path}: 需要 16k/mono/s16，实际 {w.getframerate()}/{w.getnchannels()}/{w.getsampwidth()}")
        return w.readframes(w.getnframes())


def speech_bounds_ms(pcm: bytes, thresh: int = 200) -> tuple[int, int]:
    """合成音频里语音区间（首/末个 |x|>thresh 样本），用于「语音结束→definite」延迟。"""
    n = len(pcm) // 2
    s = struct.unpack("<%dh" % n, pcm)
    first = next((i for i, x in enumerate(s) if abs(x) > thresh), 0)
    last = next((i for i in range(n - 1, -1, -1) if abs(s[i]) > thresh), n - 1)
    return first * 1000 // SR, last * 1000 // SR


def norm(t: str) -> str:
    return _PUNCT.sub("", t or "")


async def run_one(env: dict[str, str], *, pcm: bytes, mode: str, nonstream: bool, end_window: int,
                  hotwords: list[str], hybrid_burst_ms: int, cancel_at_frac: float, timeout: float,
                  lead_ms: int, trail_ms: int) -> dict:
    audio = b"\x00" * (SR * 2 * lead_ms // 1000) + pcm + b"\x00" * (SR * 2 * trail_ms // 1000)
    sp0, sp1 = speech_bounds_ms(pcm)
    sp0 += lead_ms
    sp1 += lead_ms
    blocks = [audio[i:i + BLOCK_BYTES] for i in range(0, len(audio) - len(audio) % BLOCK_BYTES, BLOCK_BYTES)]
    tail_dropped = len(audio) % BLOCK_BYTES  # worker 同款：不足一块的尾巴不发（本探针也不发，忠实复现）
    request_id = str(uuid.uuid4())
    headers = build_headers(env, request_id)
    init = build_init_payload(env, request_id, nonstream, end_window, hotwords)
    url = ASYNC_ASR_URL if nonstream else OLD_ASR_URL
    rec: dict = {
        "mode": mode, "nonstream": nonstream, "end_window": end_window, "hotwords_n": len(hotwords),
        "audio_ms": len(audio) * 1000 // (SR * 2), "speech_ms": [sp0, sp1], "blocks": len(blocks),
        "block_ms": BLOCK_MS, "tail_dropped_bytes": tail_dropped, "samples_sent": 0,
        "events": [], "definites": [], "interims": 0, "error": None,
    }
    t_connect0 = time.monotonic()
    ws = await asyncio.wait_for(websockets.connect(url, additional_headers=headers, max_size=16 * 1024 * 1024,
                                                   open_timeout=timeout, ping_interval=20, ping_timeout=20,
                                                   proxy=None), timeout=timeout)
    rec["connect_ms"] = round((time.monotonic() - t_connect0) * 1000)
    seq = 1
    await _send(ws, Message(type=MsgType.FullClientRequest, flag=Flags.PositiveSeq, serialization=Serialization.JSON,
                            compression=Compression.Gzip, sequence=seq,
                            payload=gzip.compress(json.dumps(init, ensure_ascii=False).encode("utf-8"))))
    t0 = time.monotonic()  # 首帧发送基准
    send_times: list[float] = []
    stop_after = len(blocks) if mode != "cancel_mid" else max(1, int(len(blocks) * cancel_at_frac))
    cancelled = False
    results: list[dict] = []
    done = asyncio.Event()

    async def receiver() -> None:
        try:
            while True:
                msg = await _recv(ws, timeout)
                now = time.monotonic()
                payload = msg.json_payload()
                if msg.type == MsgType.FullServerResponse and isinstance(payload, dict):
                    result = payload.get("result") or {}
                    utts = result.get("utterances") or []
                    last = bool(msg.flag & Flags.LastNoSeq)
                    results.append({"t_ms": round((now - t0) * 1000), "last": last, "utts": utts,
                                    "text": result.get("text", "")})
                    if last:
                        break
                elif msg.flag & Flags.LastNoSeq:
                    break
        except Exception as e:  # noqa: BLE001
            rec["error"] = f"recv: {type(e).__name__}: {str(e)[:120]}"
        finally:
            done.set()

    recv_task = asyncio.create_task(receiver())
    try:
        burst_until = 0.0
        if mode == "burst":
            burst_until = float("inf")
        elif mode == "hybrid":
            burst_until = hybrid_burst_ms / 1000.0
        elif mode == "cancel_mid":
            burst_until = float("inf")
        for i, b in enumerate(blocks[:stop_after]):
            seq += 1
            target = t0 + i * BLOCK_MS / 1000.0
            if i * BLOCK_MS / 1000.0 >= burst_until:
                delay = target - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
            await _send(ws, Message(type=MsgType.AudioOnlyClient, flag=Flags.PositiveSeq, serialization=Serialization.JSON,
                                    compression=Compression.Gzip, sequence=seq, payload=gzip.compress(b)))
            send_times.append(time.monotonic())
            rec["samples_sent"] += len(b) // 2
        if mode == "cancel_mid":
            cancelled = True
            t_cancel = time.monotonic()
            await ws.close()
            rec["cancel_at_block"] = stop_after
            rec["cancel_t_ms"] = round((t_cancel - t0) * 1000)
        else:
            seq += 1
            await _send(ws, Message(type=MsgType.AudioOnlyClient, flag=Flags.NegativeSeq, serialization=Serialization.JSON,
                                    compression=Compression.Gzip, sequence=-seq, payload=gzip.compress(b"")))
            rec["neg_seq_t_ms"] = round((time.monotonic() - t0) * 1000)
        await asyncio.wait_for(done.wait(), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        rec["error"] = (rec["error"] or "") + f" send/wait: {type(e).__name__}: {str(e)[:120]}"
    finally:
        if not recv_task.done():
            recv_task.cancel()
            with contextlib.suppress(BaseException):
                await recv_task
        with contextlib.suppress(Exception):
            await ws.close()
    if send_times:
        rec["push_ms"] = round((send_times[-1] - t0) * 1000)  # 所有块推完耗时（1x≈audio_ms，突发≈网络）
        rec["last_audio_t_ms"] = round((send_times[-1] - t0) * 1000)
    # 汇总 definite
    seen = 0
    for r in results:
        utts = r["utts"]
        for i in range(seen, len(utts)):
            u = utts[i]
            if u.get("definite"):
                rec["definites"].append({"t_ms": r["t_ms"], "text": u.get("text", ""),
                                         "start_time": u.get("start_time"), "end_time": u.get("end_time")})
                seen = i + 1
            else:
                break
        if utts and not utts[-1].get("definite"):
            rec["interims"] += 1
        if r["last"]:
            rec["last_no_seq_t_ms"] = r["t_ms"]
    rec["results_n"] = len(results)
    rec["cancelled"] = cancelled
    if rec["definites"]:
        d0 = rec["definites"][0]
        rec["first_definite_after_speech_end_ms"] = d0["t_ms"] - sp1 if mode == "1x" else None
        rec["first_definite_after_last_audio_ms"] = d0["t_ms"] - rec.get("last_audio_t_ms", 0)
        rec["definite_text"] = "".join(d["text"] for d in rec["definites"])
    return rec


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", nargs="+", required=True)
    ap.add_argument("--expect", nargs="*", default=[], help="与 --wav 一一对应的期望文本（可省）")
    ap.add_argument("--modes", default="1x,burst,hybrid,cancel_mid")
    ap.add_argument("--nonstream", type=int, default=1)
    ap.add_argument("--end-window", type=int, default=None)
    ap.add_argument("--hotwords", default="env", choices=["env", "none"])
    ap.add_argument("--hybrid-burst-ms", type=int, default=2000)
    ap.add_argument("--cancel-frac", type=float, default=0.5)
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--lead-ms", type=int, default=300)
    ap.add_argument("--trail-ms", type=int, default=800)
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--gap-s", type=float, default=0.4)
    ap.add_argument("--out", default="asr_burst_results.jsonl")
    a = ap.parse_args()
    env = load_env()
    missing = [k for k in ("VOLC_ASR_RESOURCE_ID",) if not env.get(k)]
    if not (env.get("VOLC_ASR_API_KEY") or (env.get("VOLC_APP_ID") and env.get("VOLC_ACCESS_TOKEN"))):
        missing.append("VOLC 鉴权(API_KEY 或 APP_ID+ACCESS_TOKEN)")
    if missing:
        print("缺少 env:", missing, file=sys.stderr)
        return 2
    end_window = a.end_window if a.end_window is not None else int(env.get("VOLC_ASR_END_WINDOW_MS", "150") or 150)
    hw = hotword_list(env, a.hotwords)
    modes = [m.strip() for m in a.modes.split(",") if m.strip()]
    out = Path(a.out)
    n_ok = 0
    with out.open("a", encoding="utf-8") as fo:
        for rep in range(a.repeat):
            for idx, wavp in enumerate(a.wav):
                pcm = read_wav_16k_mono(Path(wavp))
                expect = a.expect[idx] if idx < len(a.expect) else Path(wavp).stem
                for mode in modes:
                    rec = await run_one(env, pcm=pcm, mode=mode, nonstream=bool(a.nonstream), end_window=end_window,
                                        hotwords=hw, hybrid_burst_ms=a.hybrid_burst_ms, cancel_at_frac=a.cancel_frac,
                                        timeout=a.timeout, lead_ms=a.lead_ms, trail_ms=a.trail_ms)
                    rec.update({"wav": Path(wavp).name, "expect": expect, "rep": rep, "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
                    got = norm(rec.get("definite_text", ""))
                    exp = norm(expect)
                    rec["exact"] = got == exp
                    rec["first_char_ok"] = bool(got) and bool(exp) and got[0] == exp[0]
                    rec["cer_hint"] = None
                    fo.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    fo.flush()
                    n_ok += 1
                    d = rec.get("definites", [])
                    print(f"[{mode:10s}] {expect:18s} → {rec.get('definite_text','∅'):20s} blocks={rec['blocks']} push={rec.get('push_ms')}ms "
                          f"def@{d[0]['t_ms'] if d else None}ms after_last_audio={rec.get('first_definite_after_last_audio_ms')} "
                          f"after_speech_end={rec.get('first_definite_after_speech_end_ms')} last@{rec.get('last_no_seq_t_ms')} "
                          f"interims={rec['interims']} err={rec['error']}")
                    await asyncio.sleep(a.gap_s)
    print(f"done runs={n_ok} → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
