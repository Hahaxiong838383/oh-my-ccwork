#!/usr/bin/env python3
"""声纹注册脚本(Phase 1,docs/VOICEPRINT-PLAN.md)。

把任意录音(wav/m4a/mp3…,手机随手录即可)注册进声纹库 assets/speakers/registry.json:
ffmpeg 转 16k/mono/s16 → **幅度过滤只留有效语音**(与线上 ring buffer 同口径,注册/
识别特征一致)→ CAM++ 提 embedding(多文件平均)→ upsert 注册库 → 与库内他人互查
余弦(过近告警,防串认)。

用法(项目根,HK 上用 /root/voice-venv/bin/python):
    python scripts/enroll_speaker.py --name 川哥 录音1.m4a [录音2.wav ...]
    python scripts/enroll_speaker.py --list
    python scripts/enroll_speaker.py --delete 川哥

音频要求:总有效语音 ≥8s(硬门槛),建议 15s+ 自然说话(念一段话/随便聊)。
隐私:注册音频与 registry.json 均不进 git(.gitignore 已覆盖)。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

PROJ = Path(__file__).resolve().parents[1]
try:
    from voice_agent.engines.speaker_id import (  # noqa: E402
        SpeakerProfile,
        compute_embedding,
        l2_normalize,
        load_extractor,
        load_registry,
        pcm16_to_float32,
        save_registry,
    )
except ImportError:  # 非 editable 环境兜底
    sys.path.insert(0, str(PROJ / "src"))
    from voice_agent.engines.speaker_id import (
        SpeakerProfile,
        compute_embedding,
        l2_normalize,
        load_extractor,
        load_registry,
        pcm16_to_float32,
        save_registry,
    )

DEFAULT_MODEL = PROJ / "assets" / "models" / "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
DEFAULT_REGISTRY = PROJ / "assets" / "speakers" / "registry.json"
SR = 16000
_FRAME_MS = 20
_MIN_AMP = 250.0  # 与 speaker_id.AudioRingBuffer 同口径


def _to_pcm16k(src: Path) -> bytes:
    """任意音频 → 16k/mono/s16 PCM bytes。

    已是标准格式的 wav 直读(stdlib wave,免依赖——HK 无 ffmpeg 也能注册 probe 类
    音频);其余格式(m4a/mp3/48k wav…)走 ffmpeg 转码(本地 Mac 跑,产物
    registry.json 再 rsync 上服务器)。
    """
    if src.suffix.lower() == ".wav":
        try:
            with wave.open(str(src), "rb") as wf:
                if (
                    wf.getframerate() == SR
                    and wf.getnchannels() == 1
                    and wf.getsampwidth() == 2
                ):
                    return wf.readframes(wf.getnframes())
        except wave.Error:
            pass  # 非标准 wav → ffmpeg
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
             "-ar", str(SR), "-ac", "1", "-acodec", "pcm_s16le", tmp.name],
            check=True,
        )
        with wave.open(tmp.name, "rb") as wf:
            assert wf.getframerate() == SR and wf.getnchannels() == 1
            return wf.readframes(wf.getnframes())


def _speech_only(pcm: bytes) -> bytes:
    """幅度过滤:只留有效语音帧(20ms 粒度),口径与线上 ring buffer 一致。"""
    frame_bytes = SR * 2 * _FRAME_MS // 1000
    kept: list[bytes] = []
    for i in range(0, len(pcm) - frame_bytes + 1, frame_bytes):
        chunk = pcm[i : i + frame_bytes]
        arr = np.frombuffer(chunk, dtype=np.int16)
        if float(np.abs(arr.astype(np.int32)).mean()) >= _MIN_AMP:
            kept.append(chunk)
    return b"".join(kept)


def main() -> int:
    ap = argparse.ArgumentParser(description="声纹注册(Phase 1)")
    ap.add_argument("audio", nargs="*", type=Path, help="录音文件(wav/m4a/mp3…,可多个)")
    ap.add_argument("--name", help="说话人显示名(如 川哥)")
    ap.add_argument("--slug", help="英文短名(默认取 name)")
    ap.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    ap.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    ap.add_argument("--min-speech", type=float, default=8.0, help="有效语音硬门槛(秒)")
    ap.add_argument("--list", action="store_true", help="列出注册库")
    ap.add_argument("--delete", metavar="NAME", help="删除指定说话人")
    args = ap.parse_args()

    profiles = load_registry(args.registry) if args.registry.is_file() else []

    if args.list:
        if not profiles:
            print("注册库为空")
        for p in profiles:
            print(f"  {p.name} (slug={p.slug}, samples={p.samples}, dim={p.embedding.shape[0]})")
        return 0

    if args.delete:
        kept = [p for p in profiles if p.name != args.delete]
        if len(kept) == len(profiles):
            print(f"✗ 未找到 {args.delete}")
            return 1
        save_registry(args.registry, kept, model_label=args.model.stem)
        print(f"✓ 已删除 {args.delete}(剩 {len(kept)} 人)")
        return 0

    if not args.name or not args.audio:
        ap.error("注册需要 --name 与至少一个录音文件(或用 --list / --delete)")

    if not args.model.is_file():
        print(f"✗ 模型不存在:{args.model}(见 docs/VOICEPRINT-PLAN.md §2 下载)")
        return 1

    print(f"加载模型 {args.model.name} …")
    extractor = load_extractor(args.model)

    embs: list[np.ndarray] = []
    total_speech = 0.0
    for audio in args.audio:
        pcm = _speech_only(_to_pcm16k(audio))
        speech_s = len(pcm) / (SR * 2)
        total_speech += speech_s
        print(f"  {audio.name}: 有效语音 {speech_s:.1f}s")
        if speech_s < 1.0:
            print("    ⚠️ 该文件几乎无有效语音,跳过")
            continue
        embs.append(compute_embedding(extractor, pcm16_to_float32(pcm)))
    if not embs or total_speech < args.min_speech:
        print(
            f"✗ 有效语音共 {total_speech:.1f}s < {args.min_speech}s,"
            "请录长一点(建议 15s+ 自然说话)"
        )
        return 1

    emb = l2_normalize(np.mean(np.stack(embs), axis=0))
    others = [p for p in profiles if p.name != args.name]
    replacing = len(others) < len(profiles)
    new_profile = SpeakerProfile(
        name=args.name, slug=args.slug or args.name, embedding=emb, samples=len(embs)
    )
    # 串认自检:与库内他人余弦过近说明区分度差(同设备底噪/同人重名?)
    for p in others:
        cos = float(np.dot(emb, p.embedding))
        flag = "⚠️ 过近,易串认!" if cos >= 0.7 else "ok"
        print(f"  自检 vs {p.name}: cosine={cos:.3f} {flag}")

    save_registry(args.registry, [*others, new_profile], model_label=args.model.stem)
    action = "更新(换纹)" if replacing else "注册"
    print(
        f"✓ {action} {args.name}:{len(embs)} 段样本 / "
        f"有效语音 {total_speech:.1f}s / dim={emb.shape[0]}"
    )
    print(f"  注册库 {args.registry}(共 {len(others) + 1} 人)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
