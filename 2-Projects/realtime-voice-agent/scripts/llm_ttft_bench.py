#!/usr/bin/env python3
"""LLM TTFT bench:统一口径实测「首个非空 content 字」延迟,横向对比国内 flash 级模型。

⚠️ 口径(2026-06-29 实锤的坑):流式首字节常是**空 role 占位 chunk**(content=''),
curl 首字节计时会骗人(170ms vs 真实 755ms);``reasoning_content``(思考流)也不算。
本脚本只认第一个非空 ``delta.content``。

用法(在 HK ECS / dev198 项目根跑,自动读 .env;缺 key 的模型自动 SKIP):
  .venv/bin/python scripts/llm_ttft_bench.py                 # 跑内置模型表,6 轮/模型
  .venv/bin/python scripts/llm_ttft_bench.py --rounds 10
  .venv/bin/python scripts/llm_ttft_bench.py --only deepseek,qwen
  .venv/bin/python scripts/llm_ttft_bench.py --list-models https://api.deepseek.com/v1 LLM_API_KEY

内置表的第三方模型名可能过时(各平台改版快):跑之前先 --list-models 查该平台当前
可用名,再用环境变量(ARK_MODEL / QWEN_MODEL / GLM_MODEL / KIMI_MODEL / MINIMAX_MODEL)覆盖。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

PROJ = Path(__file__).resolve().parents[1]

# 模拟线上真实负载:system 人设 ~250 字(prefill 影响 TTFT,空 system 会测出虚快)
SYSTEM = (
    "你是一个温暖的中文实时语音助手,名字叫小可。你的回答会被直接转成语音播给用户听,"
    "所以要口语化、简短、自然,像日常聊天一样,一般一两句话说完,不用列表、不用markdown、"
    "不出现网址和代码。遇到不确定的事情就坦诚说不知道,不编造。用户可能是孩子,"
    "语气要友好耐心,内容要安全健康,不聊暴力、恐怖或不适合孩子的话题。"
    "如果用户打断你,自然地接住新话题。回答中不要自称人工智能模型,就用小可这个身份。"
)
USER_PROMPT = "用一句话回答:天空为什么是蓝色的?"


@dataclass
class ModelSpec:
    name: str
    base_url: str
    model: str
    key_env: str
    extra_body: dict[str, Any] = field(default_factory=dict)
    note: str = ""


def _builtin_specs() -> list[ModelSpec]:
    return [
        ModelSpec(
            name="deepseek",
            base_url="https://api.deepseek.com/v1",
            model=os.environ.get("LLM_MODEL", "deepseek-v4-flash"),
            key_env="LLM_API_KEY",
            extra_body={"thinking": {"type": "disabled"}},
            note="当前线上基线",
        ),
        ModelSpec(
            name="doubao",
            base_url="https://ark.cn-beijing.volces.com/api/v3",
            model=os.environ.get("ARK_MODEL", "doubao-seed-1-6-flash-250615"),
            key_env="ARK_API_KEY",
            extra_body={"thinking": {"type": "disabled"}},
            note="火山方舟(独立于 RTC);模型名先 --list-models 验证",
        ),
        ModelSpec(
            name="qwen",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            model=os.environ.get("QWEN_MODEL", "qwen-flash"),
            key_env="DASHSCOPE_API_KEY",
            extra_body={"enable_thinking": False},
            note="阿里百炼",
        ),
        ModelSpec(
            name="glm",
            base_url="https://open.bigmodel.cn/api/paas/v4",
            model=os.environ.get("GLM_MODEL", "glm-4.5-flash"),
            key_env="ZHIPU_API_KEY",
            extra_body={"thinking": {"type": "disabled"}},
            note="智谱;flash 档免费",
        ),
        ModelSpec(
            name="kimi",
            base_url="https://api.moonshot.cn/v1",
            model=os.environ.get("KIMI_MODEL", "kimi-k2-turbo-preview"),
            key_env="MOONSHOT_API_KEY",
            note="月之暗面",
        ),
        ModelSpec(
            name="minimax",
            base_url="https://api.minimaxi.com/v1",
            model=os.environ.get("MINIMAX_MODEL", "MiniMax-Text-01"),
            key_env="MINIMAX_API_KEY",
            note="MiniMax",
        ),
    ]


def _load_env() -> None:
    env_file = PROJ / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


async def _one_round(
    client: httpx.AsyncClient, spec: ModelSpec, api_key: str
) -> tuple[float, float]:
    """返回 (首个非空 content 字的 TTFT 秒, 输出 tps)。异常往上抛。

    tps 同样关键(2026-07-02 HK 实锤):v4-flash TTFT ~550 不差,但输出仅 ~12 tps,
    短首句 8 token 也要累积 ~660ms 才能进 TTS——首句出声速度 = TTFT + 首句长/tps。"""
    payload: dict[str, Any] = {
        "model": spec.model,
        "stream": True,
        "max_tokens": 64,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": USER_PROMPT},
        ],
        **spec.extra_body,
    }
    t0 = time.perf_counter()
    t_first: float | None = None
    t_last = 0.0
    n_chunks = 0
    n_chars = 0
    async with client.stream(
        "POST",
        f"{spec.base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=30.0,
    ) as resp:
        if resp.status_code != 200:
            body = (await resp.aread()).decode(errors="replace")[:200]
            raise RuntimeError(f"HTTP {resp.status_code}: {body}")
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            for choice in obj.get("choices") or []:
                delta = choice.get("delta") or {}
                content = delta.get("content")
                if content:  # 关键:空 role chunk / reasoning_content 都不算
                    now = time.perf_counter()
                    if t_first is None:
                        t_first = now
                    t_last = now
                    n_chunks += 1
                    n_chars += len(str(content))
    if t_first is None:
        raise RuntimeError("流结束仍无非空 content")
    span = max(t_last - t_first, 1e-6)
    tps = (n_chunks - 1) / span if n_chunks > 1 else 0.0
    return t_first - t0, tps


async def bench_model(spec: ModelSpec, rounds: int) -> str:
    api_key = os.environ.get(spec.key_env, "")
    if not api_key:
        return f"| {spec.name} | `{spec.model}` | SKIP(缺 {spec.key_env}) | | | | {spec.note} |"
    ttfts: list[float] = []
    tpss: list[float] = []
    err = ""
    async with httpx.AsyncClient() as client:
        for i in range(rounds):
            try:
                ttft, tps = await _one_round(client, spec, api_key)
                ttfts.append(ttft * 1000)
                if tps > 0:
                    tpss.append(tps)
                print(
                    f"  {spec.name} #{i + 1}: {ttft * 1000:.0f}ms tps={tps:.0f}",
                    file=sys.stderr,
                )
            except Exception as e:  # noqa: BLE001
                err = str(e)[:120]
                print(f"  {spec.name} #{i + 1}: ERROR {err}", file=sys.stderr)
            await asyncio.sleep(0.3)
    if not ttfts:
        return f"| {spec.name} | `{spec.model}` | 全部失败: {err} | | | | | {spec.note} |"
    cold = ttfts[0]
    warm = ttfts[1:] or ttfts
    p50 = statistics.median(warm)
    p95 = sorted(warm)[max(0, int(len(warm) * 0.95) - 1)] if len(warm) > 1 else warm[0]
    tps_p50 = statistics.median(tpss) if tpss else 0.0
    return (
        f"| {spec.name} | `{spec.model}` | {cold:.0f} | {p50:.0f} | {p95:.0f} "
        f"| {min(warm):.0f} | {tps_p50:.0f} | {spec.note} |"
    )


async def list_models(base_url: str, key_env: str) -> int:
    api_key = os.environ.get(key_env, "")
    if not api_key:
        print(f"缺 {key_env}", file=sys.stderr)
        return 1
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{base_url.rstrip('/')}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=15.0,
        )
        print(resp.text[:3000])
    return 0


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rounds", type=int, default=6)
    ap.add_argument("--only", default="", help="逗号分隔的模型 name 过滤")
    ap.add_argument("--list-models", nargs=2, metavar=("BASE_URL", "KEY_ENV"))
    args = ap.parse_args()
    _load_env()
    if args.list_models:
        return await list_models(*args.list_models)

    specs = _builtin_specs()
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        specs = [s for s in specs if s.name in wanted]
    print(f"TTFT bench(首个非空 content 字,{args.rounds} 轮/模型,system {len(SYSTEM)} 字)\n")
    rows = [await bench_model(s, args.rounds) for s in specs]
    print("\n| 模型 | model id | 冷(首轮)ms | p50 | p95 | min | tps | 备注 |")
    print("|---|---|---|---|---|---|---|---|")
    for r in rows:
        print(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
