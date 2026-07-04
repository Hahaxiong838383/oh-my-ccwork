"""信号响应探针:测 silero VAD 与 sherpa STT 对各类信号的响应(离线诊断)。

用途:回答"合成音能否造出 false interruption 触发条件(silero 判语音 SOS + STT 不出转写)"。
false interruption = agent 被 pause 后 2s 内 STT 无 final;需要 silero SOS 但 sherpa 出空文本。
输出每种信号的 SOS/EOS/maxprob + sherpa 文本,标出 "SOS+空" 候选。

跑:cd ~/realtime-voice-agent && python scripts/sig_probe.py [--model-dir ... --wav ...]
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import wave

import numpy as np

SR = 16000


def _sine(f: float, sec: float, amp: int = 8000) -> np.ndarray:
    t = np.arange(int(sec * SR)) / SR
    return (np.sin(2 * np.pi * f * t) * amp).astype(np.int16)


def _chirp(f0: float, f1: float, sec: float, amp: int = 8000) -> np.ndarray:
    t = np.arange(int(sec * SR)) / SR
    ph = 2 * np.pi * (f0 * t + (f1 - f0) / (2 * sec) * t * t)
    return (np.sin(ph) * amp).astype(np.int16)


def _voiced(sec: float, f0: float = 130, amp: int = 7000) -> np.ndarray:
    """浊音样:基频+谐波+淡入淡出包络(模拟元音哼鸣)。"""
    t = np.arange(int(sec * SR)) / SR
    sig = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 10))
    env = np.clip(t / 0.05, 0, 1) * np.clip((sec - t) / 0.05, 0, 1)
    return (sig / np.max(np.abs(sig)) * amp * env).astype(np.int16)


def _white(sec: float, amp: int = 9000) -> np.ndarray:
    return (np.random.default_rng(7).standard_normal(int(sec * SR)) * amp).astype(np.int16)


def _real(path: str, sec: float = 1.2) -> np.ndarray:
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, np.int16)[: int(sec * SR)].copy()


async def _silero(vad: object, pcm: np.ndarray) -> dict[str, float]:
    from livekit import rtc
    from livekit.agents import vad as vadmod

    st = vad.stream()  # type: ignore[attr-defined]
    step = SR // 100
    res = {"sos": 0.0, "eos": 0.0, "mx": 0.0}

    async def feed() -> None:
        for i in range(0, len(pcm), step):
            c = pcm[i : i + step]
            if len(c) < step:
                c = np.pad(c, (0, step - len(c)))
            st.push_frame(rtc.AudioFrame(c.tobytes(), SR, 1, len(c)))
        sil = np.zeros(step, np.int16)
        for _ in range(120):  # 1.2s 静音收尾触发 EOS
            st.push_frame(rtc.AudioFrame(sil.tobytes(), SR, 1, step))
        st.end_input()

    async def collect() -> None:
        async for ev in st:
            if ev.type == vadmod.VADEventType.START_OF_SPEECH:
                res["sos"] += 1
            elif ev.type == vadmod.VADEventType.END_OF_SPEECH:
                res["eos"] += 1
            elif ev.type == vadmod.VADEventType.INFERENCE_DONE:
                res["mx"] = max(res["mx"], ev.probability)

    try:
        await asyncio.wait_for(asyncio.gather(feed(), collect()), timeout=25)
    except asyncio.TimeoutError:
        await st.aclose()
    return res


def _sherpa(rec: object, pcm: np.ndarray) -> str:
    s = rec.create_stream()  # type: ignore[attr-defined]
    s.accept_waveform(SR, pcm.astype(np.float32) / 32768.0)
    s.input_finished()
    while rec.is_ready(s):  # type: ignore[attr-defined]
        rec.decode_stream(s)  # type: ignore[attr-defined]
    return str(rec.get_result(s) or "")  # type: ignore[attr-defined]


async def main(a: argparse.Namespace) -> None:
    sys.path.insert(0, "src")
    from livekit.plugins import silero

    from voice_agent.engines.sherpa_stt import build_sherpa_recognizer

    vad = silero.VAD.load()
    rec = build_sherpa_recognizer(a.model_dir)
    real = _real(a.wav)
    sigs = {
        "白噪声": _white(1.2),
        "正弦220Hz": _sine(220, 1.2),
        "chirp100-300": _chirp(100, 300, 1.2),
        "浊音f0=130": _voiced(1.2),
        "真人低音量1/10": (real // 10).astype(np.int16),
        "reversed真人": real[::-1].copy(),
        "真人正向": real,
    }
    print(f"{'信号':<18}{'SOS':>4}{'EOS':>4}{'maxprob':>9}  sherpa文本")
    for name, pcm in sigs.items():
        r = await _silero(vad, pcm)
        txt = _sherpa(rec, pcm).strip()
        flag = "  ← FALSE候选(SOS+空)" if (r["sos"] >= 1 and not txt) else ""
        print(f"{name:<18}{int(r['sos']):>4}{int(r['eos']):>4}{r['mx']:>9.3f}  {txt!r}{flag}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", default="/Users/fu-121/models/sherpa-para")
    p.add_argument("--wav", default="/Users/fu-121/models/sherpa-para/test_wavs/0.wav")
    asyncio.run(main(p.parse_args()))
