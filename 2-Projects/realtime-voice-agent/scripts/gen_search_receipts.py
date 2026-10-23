#!/usr/bin/env python3
"""Generate candidate-only search PCM assets using the configured TTS voice.

Credentials are consumed from the process environment, never arguments or output.
Run outside a conversation; generation does not change the active asset directory.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import wave

CATALOG = [
    ("lookup", "我查查。"), ("find", "我找找。"), ("search", "我搜搜。"),
    ("weather", "查查天气。"), ("news", "看看新闻。"), ("clarify", "想查什么？"),
]

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--generator", type=Path, default=Path(__file__).with_name("gen_fillers.py"))
    args = parser.parse_args()
    if args.out.exists():
        raise RuntimeError("output directory already exists; choose a fresh staging directory")
    if os.environ.get("TTS_PROVIDER") != "xfyun":
        raise RuntimeError("this asset generator requires the configured xfyun provider")
    creds = {k: os.environ.get("XFYUN_TTS_" + suffix, "") for k, suffix in
             [("app_id", "APP_ID"), ("api_key", "API_KEY"), ("api_secret", "API_SECRET")]}
    voice = os.environ.get("XFYUN_TTS_VCN", "x6_lingxiaoxuan_pro")
    if not all(creds.values()):
        raise RuntimeError("configured TTS credentials missing")
    spec = importlib.util.spec_from_file_location("receipt_generator", args.generator)
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    args.out.mkdir(parents=True, mode=0o700)
    entries, durations = [], {}
    for clip_id, text in CATALOG:
        name = clip_id + ".wav"
        await gen._synth_one_xfyun(args.out, name, text, creds, voice)
        path = args.out / name
        with wave.open(str(path), "rb") as wav:
            assert (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) == (1, 24000, 2)
            duration = wav.getnframes() * 1000 / 24000
            assert 100 <= duration <= 1800, f"{clip_id}: duration outside 100..1800ms"
        durations[clip_id] = duration
        entries.append({"id": clip_id, "file": name, "text": text,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    manifest = {"version": 1, "provider": "xfyun", "voice": voice, "clips": entries}
    # Publish manifest last: partial generation cannot be activated as a valid bank.
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"provider": "xfyun", "voice": voice, "durations_ms": durations,
                      "manifest_sha256": hashlib.sha256((args.out / "manifest.json").read_bytes()).hexdigest()}))

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        # Provider exceptions can contain signed URLs. Do not emit their arguments.
        raise SystemExit("search receipt generation failed: " + type(exc).__name__)
