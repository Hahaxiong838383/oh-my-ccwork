"""step 2:中文判停对照评测集(FLEURS cmn_hans_cn test → 正/负类样本)。

设计口径(细节与局限见 docs/EOT-ONNX-PROTOTYPE-REPORT.md):
- 来源:google/fleurs cmn_hans_cn test split(真人中文朗读,16k mono)。
  局限:朗读风格≠对话风格,无自然填充词;原型档位可接受,报告里明说。
- 每条完整句产两个样本,统一到「生产静音触发点」形态(VAD 静音累积 200ms 那一刻):
  - 正类 label=1(说完了,应判停):trim 尾静音 → append 200ms 零
    (不 trim 会把 FLEURS 句尾自带长静音喂给模型,系统性偏向「判停」,评测失真)
  - 负类 label=0(没说完,不应判停):有效音频 40%–70% 处截断 → append 200ms 零
    (截点落词中=硬截断,落句内自然停顿=难负类;两种混合,固定种子可复现)
- 窗口口径:各模型用各自生产口径(旧 1.2s 尾窗 / 新 8s 左 pad)= 公平。

用法: python build_evalset.py <fleurs_parquet> <out_dir> [n_utts=150]
输出: <out_dir>/*.wav + manifest.tsv(路径\tlabel\tcase_id) + meta.json(参数+指纹)
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import wave
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf

SR = 16000
SIL_APPEND = int(0.2 * SR)  # 生产触发点:静音累积 200ms
FRAME = int(0.025 * SR)  # trim 用能量帧 25ms
TRIM_REL_DB = 0.02  # 帧 RMS < 全局峰值 RMS 的 2% 视为静音(约 -34dB)
MIN_DUR_S, MAX_DUR_S = 3.0, 12.0
CUT_LO, CUT_HI = 0.40, 0.70
SEED = 20260815


def trim_trailing_silence(pcm: np.ndarray) -> np.ndarray:
    n_frames = len(pcm) // FRAME
    if n_frames == 0:
        return pcm
    frames = pcm[: n_frames * FRAME].astype(np.float64).reshape(n_frames, FRAME)
    rms = np.sqrt((frames**2).mean(axis=1))
    thresh = rms.max() * TRIM_REL_DB
    voiced = np.nonzero(rms > thresh)[0]
    if len(voiced) == 0:
        return pcm
    return pcm[: (voiced[-1] + 1) * FRAME]


def write_wav(path: Path, pcm: np.ndarray) -> str:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.astype("<i2").tobytes())
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parquet_path = sys.argv[1]
    out_dir = Path(sys.argv[2])
    n_utts = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    out_dir.mkdir(parents=True, exist_ok=True)

    t = pq.read_table(parquet_path, columns=["id", "audio", "transcription"])
    rng = np.random.default_rng(SEED)
    rows = []
    manifest = []
    silence = np.zeros(SIL_APPEND, dtype=np.int16)

    for i in range(t.num_rows):
        if len(rows) >= n_utts:
            break
        audio = t["audio"][i].as_py()
        # FLEURS parquet 内嵌 float32 WAV(format 3),标准库 wave 不认 → soundfile
        data, rate = sf.read(io.BytesIO(audio["bytes"]), dtype="float32")
        if rate != SR or data.ndim != 1:
            continue
        pcm = np.clip(data * 32768.0, -32768, 32767).astype(np.int16)
        trimmed = trim_trailing_silence(pcm)
        dur = len(trimmed) / SR
        if not (MIN_DUR_S <= dur <= MAX_DUR_S):
            continue

        # FLEURS 的 id 是句子 id 非唯一键(同句多说话人)——裸用会同名覆盖,
        # 实测 150 utt 里 19 个重复。复合行号保证唯一。
        utt_id = f"{len(rows):03d}s{t['id'][i].as_py()}"
        cut_frac = float(rng.uniform(CUT_LO, CUT_HI))
        cut = trimmed[: int(len(trimmed) * cut_frac)]

        pos = np.concatenate([trimmed, silence])
        neg = np.concatenate([cut, silence])
        pos_name, neg_name = f"u{utt_id}_pos.wav", f"u{utt_id}_neg.wav"
        pos_sha = write_wav(out_dir / pos_name, pos)
        neg_sha = write_wav(out_dir / neg_name, neg)
        manifest.append((pos_name, 1, f"u{utt_id}_pos"))
        manifest.append((neg_name, 0, f"u{utt_id}_neg"))
        rows.append(
            {
                "id": utt_id,
                "dur_trimmed_s": round(dur, 3),
                "cut_frac": round(cut_frac, 4),
                "transcription": t["transcription"][i].as_py(),
                "pos_sha256": pos_sha,
                "neg_sha256": neg_sha,
            }
        )

    lines = [f"{name}\t{label}\t{case}" for name, label, case in manifest]
    (out_dir / "manifest.tsv").write_text("\n".join(lines) + "\n")
    meta = {
        "source": "google/fleurs cmn_hans_cn test parquet (hf api)",
        "n_utts": len(rows),
        "n_samples": len(manifest),
        "seed": SEED,
        "trim_rel": TRIM_REL_DB,
        "sil_append_ms": 200,
        "cut_range": [CUT_LO, CUT_HI],
        "dur_range_s": [MIN_DUR_S, MAX_DUR_S],
        "total_audio_s": round(sum(r["dur_trimmed_s"] for r in rows), 1),
        "utts": rows,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    print(f"built {len(rows)} utts -> {len(manifest)} samples, total {meta['total_audio_s']}s")
    assert len(rows) == n_utts, f"only {len(rows)} usable utts (wanted {n_utts})"


if __name__ == "__main__":
    main()
