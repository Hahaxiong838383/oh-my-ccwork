"""S2 声纹对撞:同一段 wav,新构建(sherpa 1.13.5 × ORT 1.28)vs 生产现役
(venv sherpa 1.13.3 × ORT 1.24.4)的 embedding 余弦相似度。

判据(tasks/voice-eot-上线前置.md S2):cos >= 0.999 → registry.json 旧向量可直接复用;
低于则声纹全量重注册(注册人数少,成本低)。生产比对阈值 SPEAKER_ID_THRESHOLD=0.50,
0.999 的判据余量对它是 500 倍量级。

跑法(64.90):
  /root/voice-venv/bin/python compare_embeddings.py <campplus.onnx> <wav> <spk_embed输出.txt>
  其中第三个参数 = 新构建 spk_embed 二进制对同一 wav 的 stdout 落盘。
"""

from __future__ import annotations

import sys
import wave

import numpy as np


def venv_embedding(model: str, wav_path: str) -> np.ndarray:
    """生产现役路径:与 sidecar/eot_sidecar.py::_speaker_embed 同款调用。"""
    import sherpa_onnx

    with wave.open(wav_path) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    samples = (pcm.astype(np.float32) / 32768.0).copy()

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=model, num_threads=1, debug=False, provider="cpu"
    )
    assert config.validate(), f"invalid speaker model config {model}"
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(config)
    stream = ex.create_stream()
    stream.accept_waveform(sample_rate=16000, waveform=samples)
    stream.input_finished()
    return np.array(ex.compute(stream), dtype=np.float32)


def load_probe_output(path: str) -> np.ndarray:
    lines = open(path).read().split()
    assert lines[0] == "dim", f"unexpected probe output head: {lines[:2]}"
    dim = int(lines[1])
    v = np.array([float(x) for x in lines[2 : 2 + dim]], dtype=np.float32)
    assert len(v) == dim, f"probe output truncated: {len(v)}/{dim}"
    return v


def main() -> None:
    model, wav_path, probe_out = sys.argv[1:4]
    old = venv_embedding(model, wav_path)
    new = load_probe_output(probe_out)
    assert old.shape == new.shape, f"dim mismatch old={old.shape} new={new.shape}"

    def l2(v: np.ndarray) -> np.ndarray:
        n = float(np.linalg.norm(v))
        return v / n if n > 0 else v

    cos = float(np.dot(l2(old), l2(new)))
    max_abs = float(np.abs(old - new).max())
    print(f"dim={len(old)} cos={cos:.6f} max_abs_diff={max_abs:.3e} "
          f"norm_old={np.linalg.norm(old):.4f} norm_new={np.linalg.norm(new):.4f}")
    verdict = "PASS (registry 向量可复用)" if cos >= 0.999 else "FAIL (需全量重注册)"
    print(f"S2 verdict: {verdict}")
    sys.exit(0 if cos >= 0.999 else 1)


if __name__ == "__main__":
    main()
