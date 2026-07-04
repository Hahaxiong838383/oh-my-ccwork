#!/usr/bin/env python3
"""生成 C1 v2 语义分桶承接音资产(assets/fillers/*.wav + manifest.json)。

用与线上 TTS **完全相同的火山音色**预合成承接短句,worker 运行时按用户问题
语义选桶零延迟重放(engines/fillers.py)。桶:
  ask =疑问/知识类("怎么/为什么/吗…")  task=请求/任务类("讲/给我/帮我…")  gen =兜底

在项目根跑(自动读 .env 火山凭据):
    .venv/bin/python scripts/gen_fillers.py

⚠️ 换音色(VOLC_TTS_SPEAKER)或改文案后必须重跑;脚本会清掉目录里旧 wav/manifest。
文案原则(2026-07-02 川哥反馈):比语气词长一点(~1.5-2.5s),语义要接得住用户的话。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import wave
from pathlib import Path

PROJ = Path(__file__).resolve().parents[1]
OUT_DIR = PROJ / "assets" / "fillers"
SR = 24000

# 桶 → 文案变体(2026-07-02 v3,按《人类日常对话句式全面指南》重设计,9 桶 29 条)。
# 文案原则:①语气词承载情绪(哎/哟/嗐/嗯呐/哈/呀——指南 §四语气词表;别全用
# "好/行"应答词开头,显生涩)②只做承接不给立场(不抢 LLM 的答案;backchannel
# 感叹可以,追问"然后呢"不行——会和紧跟的正式回复打架)③共情优先(指南 §10:
# 用户带情绪先接住情绪,内容让 LLM 给)。
# 时长:目标 1.2-2.5s(emo_v2 实测 ~0.28s/字 → 4-9 字);>3s 必砍(拖回复开播)。
# v3.1(2026-07-03 川哥听感反馈):补每桶超短变体(~1-1.5s)打破"字数都一样"的
# 机械感——长短参差 + 概率静默 = 自然节奏;超短后的空隙像真人思考停顿,不空。
FILLERS: dict[str, list[str]] = {
    "greet": [
        "哎，你好呀。",
        "嗯呐，我在呢。",
        "来啦，想聊点啥？",
        "来啦。",
    ],
    "thanks": [
        "嗐，客气啥呀。",
        "小事儿一桩。",
        "哎，应该的。",
        "客气了。",
    ],
    "emo_neg": [
        "哎呀，怎么啦？",
        "嗯，我听着呢，你说。",
        "哎，别急哈，慢慢说。",
        "哎哟，咋回事儿呀？",
        "咋啦？",
    ],
    "emo_pos": [
        "哟，啥好事儿呀？",
        "哈，听着就开心。",
        "哟嚯，可以呀。",
        "哟？",
    ],
    "task": [
        "没问题，包在我身上。",
        "行啊，这就来。",
        "来，听好了哈。",
        "嗯，我组织下哈。",
        "没问题。",
    ],
    "story": [
        "哦？是嘛。",
        "哎哟，真的假的？",
        "哇塞，还有这事儿？",
        "嗯嗯。",
        "哦？",
    ],
    "ask": [
        "嗯，好问题。",
        "这个嘛，我想想。",
        "嗯，怎么说呢。",
        "哈，你还真问着了。",
        "嗯……",
    ],
    "opinion": [
        "哈，有点意思。",
        "哦？怎么讲？",
        "哦？",
    ],
    "gen": [
        "嗯呐，我想想。",
        "哦，这样啊。",
        "那个，让我捋捋。",
        "嗯。",
    ],
}


def _load_env() -> None:
    """setdefault 加载项目 .env(不覆盖已有环境变量)。"""
    env_file = PROJ / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


async def _synth_one(fname: str, text: str) -> float:
    from doubao_speech._ws_client import tts_stream  # type: ignore[import-not-found]

    agen = tts_stream(
        text,
        speaker=os.environ.get("VOLC_TTS_SPEAKER", "zh_female_vv_uranus_bigtts"),
        audio_format="pcm",
        sample_rate=SR,
        speed_ratio=float(os.environ.get("VOLC_TTS_SPEED", "1.0")),
        app_id=os.environ["VOLC_APP_ID"],
        access_token=os.environ["VOLC_ACCESS_TOKEN"],
        resource_id=os.environ.get("VOLC_TTS_RESOURCE_ID", "seed-tts-2.0"),
    )
    pcm = bytearray()
    async for chunk in agen:
        if chunk:
            pcm.extend(bytes(chunk))
    with wave.open(str(OUT_DIR / fname), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(pcm))
    return len(pcm) / 2 / SR


async def main() -> int:
    _load_env()
    if not os.environ.get("VOLC_APP_ID") or not os.environ.get("VOLC_ACCESS_TOKEN"):
        print("缺 VOLC_APP_ID / VOLC_ACCESS_TOKEN(项目根 .env 或环境变量)", file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.wav"):
        old.unlink()
    (OUT_DIR / "manifest.json").unlink(missing_ok=True)

    speaker = os.environ.get("VOLC_TTS_SPEAKER", "zh_female_vv_uranus_bigtts")
    n = sum(len(v) for v in FILLERS.values())
    print(f"合成承接音 × {n}(speaker={speaker})→ {OUT_DIR}")
    manifest: dict[str, dict[str, str]] = {}
    for bucket, texts in FILLERS.items():
        for i, text in enumerate(texts, 1):
            fname = f"{bucket}_{i:02d}.wav"
            dur = await _synth_one(fname, text)
            manifest[fname] = {"bucket": bucket, "text": text}
            print(f"  {fname}: {text!r} → {dur:.2f}s")
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    print("manifest.json 已写。worker 重启后生效(FILLER_ENABLED=0 可关)。")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
