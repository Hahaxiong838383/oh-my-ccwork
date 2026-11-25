#!/usr/bin/env python3
"""验收多音色契约。只连已运行的本地语音服务，不写录音。"""

from __future__ import annotations

import array
import hashlib
import json
import sys
import urllib.error
import urllib.request

DEFAULT = "piper-zh-huayan-medium"


def request(url: str, method: str = "GET", payload: dict | None = None, timeout: int = 60):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read()
            header_map = {key.lower(): value for key, value in response.headers.items()}
            return response.status, header_map, body
    except urllib.error.HTTPError as error:
        return error.code, {key.lower(): value for key, value in error.headers.items()}, error.read()


def rms(pcm: bytes) -> float:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    if not samples:
        return 0.0
    total = sum(sample * sample for sample in samples)
    return (total / len(samples)) ** 0.5


def wav_pcm(blob: bytes) -> bytes:
    if not blob.startswith(b"RIFF") or b"WAVE" not in blob[:12]:
        raise SystemExit("预览不是 wav")
    marker = blob.find(b"data")
    if marker < 0:
        raise SystemExit("预览 wav 没有 data")
    return blob[marker + 8 :]


def main() -> None:
    base = sys.argv[1].rstrip("/")
    status, _, body = request(f"{base}/v1/voices")
    if status != 200:
        raise SystemExit(f"voices {status}")
    catalog = json.loads(body.decode())
    voices = catalog.get("voices")
    active = catalog.get("active")
    if not isinstance(voices, list) or len(voices) < 2:
        raise SystemExit(f"可用音色不足: {len(voices) if isinstance(voices, list) else 'invalid'}")
    ids = []
    for item in voices:
        if set(item) != {"id", "name", "description"}:
            raise SystemExit(f"音色字段不符: {sorted(item)}")
        if not all(isinstance(item[key], str) and item[key] for key in item):
            raise SystemExit("音色字段为空")
        ids.append(item["id"])
    if active not in ids:
        raise SystemExit("active 不在可用音色里")
    if DEFAULT not in ids:
        raise SystemExit("华燕不在可用音色里")
    if any(item["id"] == DEFAULT and item["name"] != "华燕" for item in voices):
        raise SystemExit("华燕名称被改掉")

    previews = {}
    fingerprints = {}
    for voice_id in ids:
        code, headers, audio = request(f"{base}/v1/voices/preview", "POST", {"id": voice_id})
        if code != 200 or headers.get("content-type", "").split(";")[0] != "audio/wav":
            raise SystemExit(f"preview {voice_id} {code}")
        if headers.get("x-tts-voice") != voice_id:
            raise SystemExit(f"preview 响应头音色不符 {voice_id}")
        pcm = wav_pcm(audio)
        level = rms(pcm)
        duration = len(pcm) / 2 / 24000
        if level < 100 or duration < 0.4:
            raise SystemExit(f"preview 能量或时长不足 {voice_id}")
        previews[voice_id] = hashlib.sha256(pcm).hexdigest()
        fingerprints[voice_id] = (headers.get("x-tts-onnx-sha256", ""), headers.get("x-tts-sid", ""))
    if len(set(previews.values())) != len(previews):
        raise SystemExit("不同音色的预览音频相同")
    for left in ids:
        for right in ids:
            if left >= right:
                continue
            same_model = fingerprints[left][0] and fingerprints[left][0] == fingerprints[right][0]
            same_sid = fingerprints[left][1] == fingerprints[right][1]
            if same_model and same_sid:
                raise SystemExit(f"{left} 与 {right} 只是同一模型同一说话人")
            if not fingerprints[left][0] or not fingerprints[right][0]:
                raise SystemExit("缺少模型指纹")

    code, _, body = request(
        f"{base}/v1/voices/active",
        "PUT",
        {"id": ids[0], "previous": "missing-voice"},
    )
    if code != 409:
        raise SystemExit(f"错误 previous 应返回 409，实际 {code}")
    status, _, body = request(f"{base}/v1/voices")
    if json.loads(body.decode())["active"] != active:
        raise SystemExit("冲突切换改动了 active")

    code, _, _ = request(
        f"{base}/v1/voices/active",
        "PUT",
        {"id": "not-a-voice", "previous": active},
    )
    if code != 404:
        raise SystemExit(f"不存在的音色应返回 404，实际 {code}")

    target = next(voice_id for voice_id in ids if voice_id != active)
    code, _, body = request(
        f"{base}/v1/voices/active",
        "PUT",
        {"id": target, "previous": active},
    )
    if code != 200 or json.loads(body.decode())["active"] != target:
        raise SystemExit(f"切换失败 {code}")
    try:
        code, headers, pcm = request(f"{base}/v1/tts", "POST", {"text": "今天天气怎么样"})
        if code != 200 or headers.get("x-tts-voice") != target or pcm.startswith(b"RIFF"):
            raise SystemExit("不带 id 的合成没有使用 active")
        if rms(pcm) < 100:
            raise SystemExit("active 合成能量不足")

    finally:
        code, _, body = request(
            f"{base}/v1/voices/active",
            "PUT",
            {"id": active, "previous": target},
        )
        if code != 200 or json.loads(body.decode())["active"] != active:
            raise SystemExit("初始音色未恢复，请检查并发修改")
    code, _, _ = request(f"{base}/v1/voices/preview", "POST", {"id": "not-a-voice"})
    if code != 404:
        raise SystemExit("不可用预览被当成成功")
    print(json.dumps({"voices": ids, "preview_sha256": previews, "models": fingerprints}, ensure_ascii=False))


if __name__ == "__main__":
    main()
