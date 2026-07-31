"""测量 job 启动各阶段耗时(B8 立项依据,2026-07-31)。

在目标机(与生产同环境)跑,加载与 worker 相同的 env,分段计时:
import 各引擎模块 / _build_stt / _build_llm / _build_tts / TurnDetector 构造。
不连 LiveKit、不建会话——纯装配开销。

用法(64.90):
    cd /root/realtime-voice-agent && set -a && . .env && . tenant-colleague.env && set +a \
      && ./voice-venv/bin/python scripts/measure_job_setup.py
"""

from __future__ import annotations

import os
import time


def _t(label: str, fn):  # type: ignore[no-untyped-def]
    t0 = time.perf_counter()
    try:
        out = fn()
        ms = (time.perf_counter() - t0) * 1000
        print(f"{label:38s} {ms:8.1f} ms")
        return out
    except Exception as exc:
        ms = (time.perf_counter() - t0) * 1000
        print(f"{label:38s} {ms:8.1f} ms  ❌ {type(exc).__name__}: {exc}")
        return None


def main() -> None:
    print(f"STT={os.environ.get('STT_PROVIDER')} TTS={os.environ.get('TTS_PROVIDER')} "
          f"LLM={os.environ.get('LLM_PROVIDER')}\n" + "-" * 60)

    t_all = time.perf_counter()

    import importlib

    agents_mod = _t("import livekit.agents", lambda: importlib.import_module("livekit.agents"))
    _t("import livekit.plugins.silero", lambda: importlib.import_module("livekit.plugins.silero"))

    from voice_agent.config import Settings
    from voice_agent.engines import tier_a_cascade as tac

    settings = _t("Settings.from_env", Settings.from_env)
    assert settings is not None and agents_mod is not None

    # 第一轮:冷(含模块 import + 凭据解密 + 模型加载)
    print("\n[冷启动:首个 job 的真实开销]")
    _t("_build_stt", lambda: tac._build_stt(settings))
    _t("_build_llm", lambda: tac._build_llm(settings))
    _t("_build_tts", lambda: tac._build_tts(settings))
    _t(
        "TurnDetector(v1-mini)",
        lambda: agents_mod.inference.TurnDetector(
            version="v1-mini",
            **(
                {"unlikely_threshold": float(os.environ["POC_EOU_UNLIKELY_THRESHOLD"])}
                if os.environ.get("POC_EOU_UNLIKELY_THRESHOLD")
                else {}
            ),
        ),
    )

    # 第二轮:热(模块已 import)——差值=可通过进程级预热省掉的部分
    print("\n[热:模块已 import,仅剩每 job 必付的构造/解密]")
    _t("_build_stt", lambda: tac._build_stt(settings))
    _t("_build_llm", lambda: tac._build_llm(settings))
    _t("_build_tts", lambda: tac._build_tts(settings))
    _t(
        "TurnDetector(v1-mini)",
        lambda: agents_mod.inference.TurnDetector(version="v1-mini"),
    )

    print("-" * 60)
    print(f"{'合计(两轮)':38s} {(time.perf_counter() - t_all) * 1000:8.1f} ms")


if __name__ == "__main__":
    main()
