"""应用入口。

组装 体验引擎 ↔ 适配器 ↔ 记忆内核 = 一个 ``VoiceSession``,打印就绪状态。
``python -m voice_agent.app`` 仍是离线自检;``python -m voice_agent.app livekit``
启动 M0 LiveKit worker。
"""

from __future__ import annotations

from typing import Any

from .adapters import LiveKitAdapter
from .config import Settings
from .engines import build_engine
from .kernel import MemoryKernel
from .pipeline import VoiceSession


def build_session(settings: Settings | None = None) -> VoiceSession:
    """组装一个会话(Tier A 默认用 ``LiveKitAdapter``;Tier B/C 改 Sidecar 合成)。"""
    resolved = settings or Settings.from_env()
    engine = build_engine(resolved)
    adapter = LiveKitAdapter()
    kernel = MemoryKernel(confidence_floor=resolved.extraction_confidence_floor)
    return VoiceSession(engine, adapter, kernel)


def main() -> None:
    settings = Settings.from_env()
    session = build_session(settings)
    print("realtime-voice-agent — 架构骨架就绪")
    print(f"  体验引擎: {settings.voice_engine}")
    print("  记忆内核: Event Log(append-only) + Working Set + 冷路径来源仲裁")
    print(f"  置信度门: {settings.extraction_confidence_floor}")
    print("  契约事件: 9 类(user/agent · speech/transcript/turn/interrupt)")
    print("  → M0 接线见 docs/PRODUCT-DEFINITION-v3.3.md §8")
    _ = session  # 骨架:已组装,未启动 RTC(需 .env 真值 + LiveKit '[tier-a]')


async def _livekit_entrypoint(ctx: object) -> None:
    """LiveKit job 入口。

    **必须是模块级函数**:livekit-agents 用 multiprocessing ``spawn`` 在子进程跑 job,
    会 pickle 本函数;嵌套在 ``run_livekit_worker`` 内的局部闭包无法 pickle
    (``Can't get local object``)。settings 在子进程内重新 ``from_env``(spawn 继承父 env)。
    """
    import asyncio
    import os

    from .engines.fast_llm import prewarm_openai
    from .engines.tier_a_cascade import TierACascadeEngine

    settings = Settings.from_env()
    engine = TierACascadeEngine(settings)
    session = VoiceSession(engine, LiveKitAdapter(), MemoryKernel())
    # 🔴 收尾修(2026-07-02 川哥 5G 实测抓出):session.run() 消费 engine 事件队列,
    # 用户 disconnect 后没人关 engine → run() 永挂 → "entrypoint did not exit in time"
    # → job 拖 ~40s 强杀,期间用户快速重连进同一 room 撞上"正在关闭的僵尸 agent"
    # → 无 greeting 无回应。shutdown 回调里 aclose(往队列放 None)让 run() 立刻退。
    from typing import Any, cast

    cast(Any, ctx).add_shutdown_callback(engine.aclose)
    await engine.start_livekit_job(ctx)
    # R3b TTS 连接池预热:首句回复 TTS 零建连(省 ~150-250ms 握手,藏进说首句窗口)。
    # 与 LLM prewarm 同款纵深防御挪到 connect 之后:协程内 import doubao_speech/
    # websockets 持 GIL,虽比 openai 税轻,也不该落在 FFI ready 的 1s deadline 窗内。
    if (
        os.environ.get("TTS_PROVIDER") == "volc"
        and os.environ.get("TTS_POOL_ENABLED", "1") == "1"
        and os.environ.get("VOLC_APP_ID")
    ):
        from .engines._volc_tts_pool import get_pool

        _tts_pool = get_pool(
            os.environ.get("VOLC_APP_ID", ""),
            os.environ.get("VOLC_ACCESS_TOKEN", ""),
            os.environ.get("VOLC_TTS_RESOURCE_ID", "seed-tts-2.0"),
        )
        asyncio.create_task(_tts_pool.prewarm())
    # 方案1 预热:异步建 LLM 连接(利用用户说首句+判停的 ~2-3s 窗口),首句 LLM 复用
    # 已建连接省 ~450ms。仅 openai style(DeepSeek 等跨网才慢;ollama 局域网建连快)。
    # 🔴 位置必须在 start_livekit_job **之后**(2026-07-03 py-spy 实锤):该协程首次
    # 访问 client.chat 会触发 openai 惰性 import(pydantic 建模 1s+ CPU 持 GIL),
    # 若放 connect 前,恰被调度进 FFI ReadyForRoomEventRequest 的 1s deadline 窗口
    # → panic。setup_process 已预 import 兜底;挪到这里是纵深防御(SDK 升级冒出新
    # 惰性路径也不落在 deadline 内)。LLM 首用在用户首句后,预热窗口依然充足。
    if os.environ.get("LLM_API_STYLE", "openai") == "openai" and settings.llm_base_url:
        asyncio.create_task(
            prewarm_openai(settings.llm_base_url, settings.llm_api_key, settings.llm_model)
        )
        # R1 赛马兜底路同样预热(否则兜底首用要付 TLS 建连,输在起跑线失去赛马意义)
        fb_base = os.environ.get("LLM_FALLBACK_BASE_URL", "")
        fb_key = os.environ.get("LLM_FALLBACK_API_KEY", "")
        fb_model = os.environ.get("LLM_FALLBACK_MODEL", "")
        if fb_base and fb_key and fb_model:
            asyncio.create_task(prewarm_openai(fb_base, fb_key, fb_model))
    await session.run()


def _deprioritize_respawn_procs(server: Any) -> None:
    """进程池补位竞态修复(2026-07-03 声纹 Phase1 验收时系统性测到,与声纹无关)。

    job 取走 idle 进程的同一秒,进程池(``proc_pool._main_task`` 0.1s 轮询)立刻
    spawn 补位进程;其 bootstrap(import livekit 全家桶 + setup_fnc onnx,2 核上
    2s+ CPU)与 job 进程的 FFI 房间握手(rust 侧 ~1s 超时,liblivekit_ffi 内写死
    不可调)抢 CPU → ~25% 概率 "timed out waiting for ReadyForRoomEventRequest"
    panic 秒崩,用户侧=点开始对话偶发无响应。

    修法:worker_started 后订阅池事件,补位子进程在 process_started(fork 完成,
    pid 已可用)→ process_ready(bootstrap 完成)窗口内降 CPU 优先级。nice 语义=
    有竞争才让路:CPU 空闲时补位速度不变,竞争时 job 握手优先拿核。启动期预热
    发生在 worker_started 之前,不受影响(全速)。``WORKER_RESPAWN_NICE=0`` 关闭。
    """
    import logging
    import os

    log = logging.getLogger("voice_agent.procpool")
    # 默认 10 而非更狠的 15/19:openai 税已由 _openai_preload 挪进 forkserver,
    # 补位 initialize 本身很轻;nice 只是兜底,压太狠会在 CPU 持续繁忙时把补位
    # 拖过 initialize timeout → 杀进程重 spawn 循环(2026-07-03 验收实测踩过)。
    nice_val = int(os.environ.get("WORKER_RESPAWN_NICE", "10"))
    if nice_val <= 0:
        return

    def _set_nice(proc: Any, value: int, stage: str) -> None:
        pid = getattr(proc, "pid", None)
        if not pid:
            return
        try:
            os.setpriority(os.PRIO_PROCESS, pid, value)
        except (OSError, PermissionError) as exc:
            # 恢复失败最伤(子进程将永久低优先级跑 job),必须可见
            log.warning("setpriority(pid=%s, nice=%s, %s) 失败: %s", pid, value, stage, exc)

    def _on_worker_started() -> None:
        # _proc_pool 是 1.6.3 私有属性(无公开访问器);升级 livekit-agents 需复核
        pool = getattr(server, "_proc_pool", None)
        if pool is None:
            log.warning("补位降优先级钩子挂载失败:AgentServer._proc_pool 不存在(库升级?)")
            return
        pool.on("process_started", lambda proc: _set_nice(proc, nice_val, "bootstrap降级"))
        pool.on("process_ready", lambda proc: _set_nice(proc, 0, "ready恢复"))
        log.info("procpool 补位降优先级钩子已挂载(nice=%s)", nice_val)

    server.on("worker_started", _on_worker_started)


def run_livekit_worker() -> None:
    """启动 M0 LiveKit worker。"""
    import importlib
    import os

    from .engines.tier_a_cascade import setup_process

    agents = importlib.import_module("livekit.agents")
    settings = Settings.from_env()
    # openai 惰性 import 税挪进 forkserver(Linux 生产;详见 _openai_preload 模块文档):
    # 注册为 Plugin 后 livekit 自动把 package 加入 set_forkserver_preload 列表。
    agents.Plugin.register_plugin(
        agents.Plugin(
            title="voice-agent-openai-preload",
            version="1.0",
            package="voice_agent.engines._openai_preload",
        )
    )
    server = agents.AgentServer(
        ws_url=settings.livekit_url or None,
        api_key=settings.livekit_api_key or None,
        api_secret=settings.livekit_api_secret or None,
        # idle 子进程预载 silero VAD:2 核机上 job 内 onnx 冷加载会阻塞 event loop →
        # restart 后首 job FFI panic(2026-07-02 HK 实测),setup_fnc 挪到 job 前。
        setup_fnc=setup_process,
        # 负载阈值:生产默认 0.7,2 核小机 job 启动 CPU 尖峰就超 → server 日志
        # "not dispatching agent job since no worker is available" 拒接新 job
        # (2026-07-02 川哥 5G 实测抓出)。专机单用户场景放宽到 0.95。
        load_threshold=float(os.environ.get("WORKER_LOAD_THRESHOLD", "0.95")),
        # initialize 超时放宽(默认 10s):补位进程被 WORKER_RESPAWN_NICE 降级让路后,
        # CPU 持续繁忙时 initialize 可能拖长;超时会杀进程重 spawn,循环本身烧 CPU
        # 反而拖垮 job 派发(2026-07-03 验收实测)。宁慢勿杀。
        initialize_process_timeout=float(os.environ.get("WORKER_INIT_TIMEOUT", "30")),
        # 🔴 内存 thrash 根治(2026-07-04 vmstat 实证:通话时 wa=91%/bi=16万块/id=0,
        # CPU 反而空闲 87-96%——瓶颈是内存不是算力)。LiveKit prod 默认 idle 进程数=
        # min(⌈CPU核数⌉,4)=2,加活跃通话进程=3 个子进程各 350-440MB 合计 1.2GB,把 2G
        # 机器打到临界;无 swap → 内核回收 page cache(285→109MB)→ 进程页/模型 mmap
        # 被丢弃 → 用时从磁盘疯狂重读 → 整机 IO 卡死几秒。单用户专机 1 个 idle 足够
        # (挂断重连时它接管 + 同时 spawn 新 idle),内存降到 ~2 进程 800MB;配 2G swap
        # 兜底新 job spawn/声纹加载的瞬时尖峰。WORKER_NUM_IDLE=0 更省但首连要现 spawn。
        num_idle_processes=int(os.environ.get("WORKER_NUM_IDLE", "1")),
    )
    server.rtc_session(_livekit_entrypoint, agent_name="realtime-voice-agent")
    _deprioritize_respawn_procs(server)
    agents.cli.run_app(server)


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "livekit":
        sys.argv.pop(1)
        run_livekit_worker()
    else:
        main()
