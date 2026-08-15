"""旧模型(livekit v1-mini 闭源 EOT)在评测集上出概率——64.90 生产机 venv 直调。

跑法(64.90,不碰任何生产 unit,直调与 sidecar 同一条 li.EOT() 推理路径):
  nice -n 19 /root/voice-venv/bin/python eval_old_model.py <evalset_dir> <out_tsv>

窗口口径 = 生产:取每个样本**最后 19200 样本(1.2s)**喂模型
(rust-worker/src/eot.rs EOT_MAX_SAMPLES;pipeline.rs 的 eot_ring 就是这个滚动窗)。
输出格式与 eotbench eval 对齐:case\tlabel\tprob\tmel_ms\tinfer_ms(mel 列恒 0,无 mel 阶段)。
"""

from __future__ import annotations

import sys
import time
import wave
from pathlib import Path

import numpy as np

EOT_MAX_SAMPLES = 19200  # 1.2s @ 16k


def main() -> None:
    evalset = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    import livekit.local_inference as li

    li.init_eot()
    eot = li.EOT()

    rows = []
    t_load0 = time.perf_counter()
    manifest = (evalset / "manifest.tsv").read_text().strip().splitlines()
    # warmup(首调含内部初始化)
    eot.predict(np.zeros(EOT_MAX_SAMPLES, dtype=np.int16))
    print(f"model ready in {time.perf_counter() - t_load0:.1f}s, {len(manifest)} samples")

    for line in manifest:
        name, label, case = line.split("\t")
        with wave.open(str(evalset / name)) as w:
            assert w.getframerate() == 16000 and w.getnchannels() == 1
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        tail = pcm[-EOT_MAX_SAMPLES:]
        t0 = time.perf_counter()
        prob = float(eot.predict(tail))
        dt_ms = (time.perf_counter() - t0) * 1e3
        rows.append(f"{case}\t{label}\t{prob:.6f}\t0.00\t{dt_ms:.2f}")

    out_path.write_text(
        "# model=livekit-v1-mini-eot window=1.2s-tail host=64.90\n"
        "case\tlabel\tprob\tmel_ms\tinfer_ms\n" + "\n".join(rows) + "\n"
    )
    print(f"evaluated {len(rows)} -> {out_path}")
    assert len(rows) > 0


if __name__ == "__main__":
    main()
