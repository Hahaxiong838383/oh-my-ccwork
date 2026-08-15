"""step 2b:官方口径中文评测集(pipecat-ai/smart-turn-data-v3.2-test 的 zho 子集,929 条)。

用途与 FLEURS 集(build_evalset.py)分工:
- 本集 = **忠实复刻官方评测口径**(音频原样 pad/trunc 8s,无任何再加工):
  在它上面复现官方自报的中文成绩(acc 85.79/FPR 4.95)= 给整条评测管线钉锚;
  三方模型(旧 v1-mini/官方 v3.2/wavekat zh)同集可比。
- FLEURS 集 = 生产触发点形态(trim+200ms 静音)+真人语音,但朗读分布偏出对话。

⚠️ 本集全部 synthetic=True(chirp3 TTS 合成对话),无真人中文——官方成绩的口径即如此。
标签:endpoint_bool(True=turn 完成)。midfiller/endfiller 标记保留在 meta 供分层。

用法: python build_evalset_official.py <zh_shards_dir> <out_dir>
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


def main() -> None:
    shards_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    shards = sorted(shards_dir.glob("zh_shard*.parquet"))
    assert shards, f"no shards in {shards_dir}"
    t = pq.ParquetDataset([str(p) for p in shards]).read()
    print(f"rows: {t.num_rows}")

    manifest, meta_rows = [], []
    resampled = 0
    for i in range(t.num_rows):
        a = t["audio"][i].as_py()
        data, rate = sf.read(io.BytesIO(a["bytes"]), dtype="float32")
        if data.ndim != 1:
            data = data.mean(axis=1)
        if rate != SR:
            import soxr

            data = soxr.resample(data, rate, SR, quality="HQ")
            resampled += 1
        pcm = np.clip(data * 32768.0, -32768, 32767).astype(np.int16)
        label = 1 if t["endpoint_bool"][i].as_py() else 0
        case = f"o{i:03d}_{'pos' if label else 'neg'}"
        name = f"{case}.wav"
        with wave.open(str(out_dir / name), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        manifest.append(f"{name}\t{label}\t{case}")
        meta_rows.append(
            {
                "case": case,
                "orig_id": t["id"][i].as_py(),
                "dur_s": round(len(pcm) / SR, 3),
                "midfiller": t["midfiller"][i].as_py(),
                "endfiller": t["endfiller"][i].as_py(),
                "sha256": hashlib.sha256(pcm.tobytes()).hexdigest()[:16],
            }
        )

    (out_dir / "manifest.tsv").write_text("\n".join(manifest) + "\n")
    n_pos = sum(1 for m in manifest if "\t1\t" in m)
    meta = {
        "source": "pipecat-ai/smart-turn-data-v3.2-test zho subset (all synthetic chirp3_1)",
        "n": len(manifest),
        "n_pos": n_pos,
        "n_neg": len(manifest) - n_pos,
        "resampled": resampled,
        "form": "verbatim official form: no trim, no appended silence (anchor for official numbers)",
        "rows": meta_rows,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    print(f"built {len(manifest)} samples (pos={n_pos} neg={len(manifest)-n_pos}, resampled={resampled})")


if __name__ == "__main__":
    main()
