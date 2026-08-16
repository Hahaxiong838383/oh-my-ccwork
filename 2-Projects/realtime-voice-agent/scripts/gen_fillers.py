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
# v4(2026-07-16 川哥反馈"重复多+要更贴语境",按《人类日常对话衔接语料库 v2.0》扩写):
# 39→66 条,每桶 6-9 个变体(配合 FillerBank 最近 3 条防重复窗,重复感大幅降);
# 语料库提炼原则:取对话示例里 B 的"第一反应词位"(回声/填充/共情启动),仍守四纪律
# (不用"好/行"应答词开头 / 只承接不给立场 / 不追问防与正文打架 / 共情优先)。
FILLERS: dict[str, list[str]] = {
    # v6(2026-08-16 川哥优化方案+cc 评审修订):9 桶全补到 9 条=81;跨桶完整短语去重;
    # 每桶保 ≥1 条超短(≤1.2s)——配合 worker 打断轮短条偏好(FILLER_BARGE_MAX_MS);
    # thanks 儿童向去成人客套;task 严守 v5 原则(中性准备腔,禁执行承诺腔/好行开头)。
    "greet": [
        "哎，你好呀。",
        "嗯呐，我在呢。",
        "来啦，想聊点啥？",
        "来啦。",
        "哎，来啦来啦。",
        "嗨，我在呢。",
        "哟，你来啦。",
        "哎哟，是你呀～",
        "嗨嗨，等你好久啦。",
    ],
    "thanks": [
        "嗐，客气啥呀。",
        "小事儿一桩。",
        "哎，应该的。",
        "客气了。",
        "嘿嘿，不用谢～",
        "嗐，说这干嘛。",
        "帮到你我可开心啦。",
        "没事没事～",
        "别客气呀，小意思。",
    ],
    "emo_neg": [
        "哎呀，怎么啦？",
        "嗯，我听着呢，你说。",
        "哎，别急哈，慢慢说。",
        "哎哟，咋回事儿呀？",
        "咋啦？",
        "哎，说来听听。",
        "嗯，你说，我听着呢。",
        "哎呀，咋啦这是。",
        "唔，别难过哈。",
    ],
    "emo_pos": [
        "哟，啥好事儿呀？",
        "哈，听着就开心。",
        "哟嚯，可以呀。",
        "哟？",
        "哇，真的呀？",
        "哟，瞧把你乐的。",
        "哈哈，快说说。",
        "哇塞，太棒啦。",
        "哈，好事呀，快讲讲。",
    ],
    # v5(2026-07-16 川哥实测)原则继续生效:禁强执行承诺腔("这就来/马上安排/包在我身上")
    # ——LLM 超时轮"承诺了却 20s 不来"更伤;只用中性内容准备腔。v6 按此原则补量 3→9。
    "task": [
        "来，听好了哈。",
        "嗯，我组织下哈。",
        "嗯，我看看哈。",
        "我弄弄哈。",
        "等等哈，我理个头绪。",
        "唔，我瞅瞅哈。",
        "嗯，我琢磨琢磨。",
        "稍等。",
        "嗯，我先理一理。",
    ],
    "story": [
        "哦？是嘛。",
        "哎哟，真的假的？",
        "哇塞，还有这事儿？",
        "嗯嗯。",
        "哦？",
        "哎哟喂，啥情况？",
        "嗯，你说你说。",
        "哇，我听着呢。",
        "哇，这么神奇？",
    ],
    "ask": [
        "嗯，好问题。",
        "这个嘛，我想想。",
        "嗯，怎么说呢。",
        "哈，你还真问着了。",
        "嗯……",
        "唔，让我捋捋。",
        "哎，这问题妙啊。",
        "我想想哈。",
        "嗯……怎么讲呢。",
    ],
    "opinion": [
        "哈，有点意思。",
        "哦？怎么讲？",
        "唔？",
        "嗯，听你这么一说。",
        "哟，有想法。",
        "嗯哼？",
        "哦？接着说接着说。",
        "哈，这角度挺新。",
        "哦，我倒想听听。",
    ],
    "gen": [
        "嗯呐，我想想。",
        "哦，这样啊。",
        "那个，让我捋捋。",
        "嗯。",
        "唔……",
        "哦哦。",
        "稍等哈。",
        "嗯，容我一下下。",
        "嗯——让我顺一顺。",
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
    return _write_wav(OUT_DIR / fname, pcm)


def _write_wav(path: Path, pcm: bytes | bytearray) -> float:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(pcm))
    return len(pcm) / 2 / SR


async def _synth_one_xfyun(
    out_dir: Path, fname: str, text: str, creds: dict[str, str], vcn: str
) -> float:
    """讯飞超拟人合成一条(2026-07-28 租户音色版:与租户正式链路同 vcn,解双音色穿帮)。"""
    import base64

    import aiohttp

    sys.path.insert(0, str(PROJ / "src"))
    from voice_agent.engines.xfyun_common import build_tts_request, build_xfyun_auth_ws_url

    url = build_xfyun_auth_ws_url(creds["api_key"], creds["api_secret"])
    req = build_tts_request(text, app_id=creds["app_id"], vcn=vcn, sample_rate=SR)
    pcm = bytearray()
    async with aiohttp.ClientSession() as http:
        async with http.ws_connect(url) as ws:
            await ws.send_str(json.dumps(req, ensure_ascii=False))
            while True:
                msg = await ws.receive(timeout=20)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    break
                obj = json.loads(msg.data)
                code = (obj.get("header") or {}).get("code")
                if code not in (0, None):
                    raise RuntimeError(
                        f"讯飞合成失败 {fname}: code={code} "
                        f"{(obj.get('header') or {}).get('message', '')}"
                    )
                audio = (obj.get("payload") or {}).get("audio") or {}
                if audio.get("audio"):
                    pcm.extend(base64.b64decode(audio["audio"]))
                if audio.get("status") == 2:
                    break
    if not pcm:
        raise RuntimeError(f"讯飞合成 0 字节: {fname}")
    return _write_wav(out_dir / fname, pcm)


def _xfyun_creds() -> tuple[dict[str, str], str]:
    """讯飞凭据:优先租户加密存储(TENANT_* env 齐,凭据不出服务器),回退 XFYUN_TTS_* env。"""
    sys.path.insert(0, str(PROJ / "src"))
    from voice_agent.tenant import load_tenant_credentials

    creds = load_tenant_credentials("xfyun_tts") or {
        "app_id": os.environ.get("XFYUN_TTS_APP_ID", ""),
        "api_key": os.environ.get("XFYUN_TTS_API_KEY", ""),
        "api_secret": os.environ.get("XFYUN_TTS_API_SECRET", ""),
        "vcn": os.environ.get("XFYUN_TTS_VCN", ""),
    }
    missing = [k for k in ("app_id", "api_key", "api_secret") if not creds.get(k)]
    if missing:
        raise RuntimeError(f"讯飞 TTS 凭据缺失 {missing}(租户存储或 XFYUN_TTS_* env)")
    return creds, creds.get("vcn") or "x6_lingxiaoxuan_pro"


async def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="生成语义分桶承接音资产")
    parser.add_argument("--engine", choices=["volc", "xfyun"], default="volc")
    parser.add_argument(
        "--out", default="", help="输出目录(默认 assets/fillers;租户资产必须换独立目录,勿混主链路)"
    )
    args = parser.parse_args()
    out_dir = Path(args.out) if args.out else OUT_DIR

    _load_env()
    if args.engine == "volc":
        if not os.environ.get("VOLC_APP_ID") or not os.environ.get("VOLC_ACCESS_TOKEN"):
            print("缺 VOLC_APP_ID / VOLC_ACCESS_TOKEN(项目根 .env 或环境变量)", file=sys.stderr)
            return 1
        speaker = os.environ.get("VOLC_TTS_SPEAKER", "zh_female_vv_uranus_bigtts")
        creds, vcn = {}, ""
    else:
        creds, vcn = _xfyun_creds()
        speaker = f"xfyun/{vcn}"

    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.wav"):
        old.unlink()
    (out_dir / "manifest.json").unlink(missing_ok=True)

    n = sum(len(v) for v in FILLERS.values())
    print(f"合成承接音 × {n}(speaker={speaker})→ {out_dir}")
    manifest: dict[str, dict[str, str]] = {}
    for bucket, texts in FILLERS.items():
        for i, text in enumerate(texts, 1):
            fname = f"{bucket}_{i:02d}.wav"
            if args.engine == "xfyun":
                dur = await _synth_one_xfyun(out_dir, fname, text, creds, vcn)
            else:
                dur = await _synth_one(fname, text)
            manifest[fname] = {"bucket": bucket, "text": text}
            print(f"  {fname}: {text!r} → {dur:.2f}s")
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    print("manifest.json 已写。worker 重启后生效(FILLER_ENABLED=0 可关)。")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
