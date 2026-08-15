"""生成 Rust smart-turn 移植的数值对拍靶（三绿②的 reference 侧）。

对拍口径 = Pipecat 官方 vendored numpy 实现（_whisper_features.py + local_smart_turn_v3.py
的 _predict_endpoint 管线）：>8s 取尾 / <8s 左 pad 零 → do_normalize=True 的
Whisper log-mel [80,800] → ONNX 推理出 P(complete)。

重采样（soxr）不进对拍环：本脚本把源 wav 统一落成 16k mono wav，
Python 与 Rust 两侧消费同一个 16k 文件。

用法:
  python gen_parity_refs.py <pipecat_ref_dir> <models_dir> <out_dir>

  pipecat_ref_dir: 含 _whisper_features.py（从 pipecat 主仓下载，见报告 URL）
  models_dir:      含 smart-turn-v3.2-cpu.onnx / smart-turn-zh-cpu.onnx
  out_dir:         输出 <case>.wav / <case>.mel.f32 / refs.json

输出 refs.json: 每 case 的 mel sha256、官方/zh 概率（float 十进制 + 位精确 hex）。
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
import wave
from pathlib import Path

import numpy as np

SR = 16000
N_SAMPLES_8S = SR * 8  # 128000


def read_wav_mono(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path)) as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, path
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return pcm, rate


def write_wav_16k(path: Path, pcm: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.astype(np.int16).tobytes())


def to_16k(pcm: np.ndarray, rate: int) -> np.ndarray:
    if rate == SR:
        return pcm
    import soxr

    f = pcm.astype(np.float32) / 32768.0
    out = soxr.resample(f, rate, SR, quality="HQ")
    return np.clip(out * 32768.0, -32768, 32767).astype(np.int16)


def pad_or_trunc_8s(f32: np.ndarray) -> np.ndarray:
    """local_smart_turn_v3.truncate_audio_to_last_n_seconds 同款：>8s 取尾，<8s 左 pad。"""
    if len(f32) > N_SAMPLES_8S:
        return f32[-N_SAMPLES_8S:]
    if len(f32) < N_SAMPLES_8S:
        return np.pad(f32, (N_SAMPLES_8S - len(f32), 0), mode="constant", constant_values=0)
    return f32


def main() -> None:
    ref_dir, models_dir, out_dir = (Path(p) for p in sys.argv[1:4])
    sys.path.insert(0, str(ref_dir))
    from _whisper_features import compute_whisper_log_mel_features  # noqa: E402

    import onnxruntime as ort

    sessions = {}
    for tag, fname in [("official", "smart-turn-v3.2-cpu.onnx"), ("zh", "smart-turn-zh-cpu.onnx")]:
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 1
        sessions[tag] = ort.InferenceSession(str(models_dir / fname), sess_options=so)

    out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20260815)

    fillers = Path(__file__).resolve().parent.parent.parent / "assets" / "fillers"
    cases: dict[str, np.ndarray] = {}
    for name in ["gen_01", "story_01", "ask_01"]:
        pcm, rate = read_wav_mono(fillers / f"{name}.wav")
        cases[f"zh_{name}"] = to_16k(pcm, rate)
    cases["noise_2s"] = (rng.normal(0, 1500, SR * 2)).astype(np.int16)
    cases["silence_1s"] = np.zeros(SR, dtype=np.int16)
    t = np.arange(int(SR * 8.5), dtype=np.float64) / SR
    cases["sine440_8p5s"] = (np.sin(2 * np.pi * 440 * t) * 8000).astype(np.int16)

    report = {}
    for name, pcm16 in cases.items():
        write_wav_16k(out_dir / f"{name}.wav", pcm16)
        f32 = pcm16.astype(np.float32) / 32768.0
        padded = pad_or_trunc_8s(f32)
        mel = compute_whisper_log_mel_features(padded, do_normalize=True)  # [80,800] f32
        mel_path = out_dir / f"{name}.mel.f32"
        mel_bytes = mel.astype("<f4").tobytes()
        mel_path.write_bytes(mel_bytes)

        probs = {}
        for tag, sess in sessions.items():
            out = sess.run(None, {"input_features": mel[None, :, :]})
            p = float(out[0][0].item())
            probs[tag] = {"prob": p, "hex": hex(struct.unpack("<I", struct.pack("<f", np.float32(p)))[0])}

        report[name] = {
            "n_samples_16k": int(len(pcm16)),
            "mel_sha256": hashlib.sha256(mel_bytes).hexdigest(),
            "mel_shape": list(mel.shape),
            **probs,
        }
        print(f"{name}: official={probs['official']['prob']:.6f} zh={probs['zh']['prob']:.6f}")

    (out_dir / "refs.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"wrote {out_dir}/refs.json")


if __name__ == "__main__":
    main()
