"""Tier A:Cascade ★MVP(ARCHITECTURE.md §8 / PRODUCT-DEFINITION §4)。

流式 STT + LLM + TTS + Silero VAD + 语义 turn detector,over LiveKit RTC。
**无需 GPU**,把火山 RTC 体验逐项工程堆出来(成败手是 AEC/降噪、VAD+语义判停、流式延迟)。

M0:本类仍支持无真值空跑,但在 ``start_livekit_job`` 里已接入 LiveKit AgentSession。
顶层不 import livekit(零依赖可测);真实接线在方法体内(``pip install '.[tier-a]'``)。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import AsyncIterator
from contextlib import suppress
from pathlib import Path
from typing import Any, ClassVar, cast

from ..config import Settings
from .base import EngineEvent, ExperienceEngine, Tier
from .livekit_bridge import LiveKitEventBridge

logger = logging.getLogger("voice_agent.tier_a")


async def _rss_monitor_loop(interval_s: float = 30.0) -> None:
    """job 进程 RSS 采样(定位 2026-07-16 OOM 的 750MB 膨胀源)。

    读 /proc/self/status 零依赖(Linux 生产专用;macOS 无 /proc 静默退出不影响开发)。
    journalctl 里 `grep 'job rss'` 即得膨胀曲线——膨胀复现时按 uptime 对齐对话轮数定位。
    """
    import time

    t0 = time.monotonic()
    while True:
        await asyncio.sleep(interval_s)
        try:
            # procfs 是内存文件,读取微秒级,不值得 to_thread 的调度开销
            with open("/proc/self/status") as f:  # noqa: ASYNC230
                for line in f:
                    if line.startswith("VmRSS:"):
                        kb = int(line.split()[1])
                        logger.info(
                            "job rss: %dMB (uptime %ds)", kb // 1024, int(time.monotonic() - t0)
                        )
                        break
        except OSError:
            return  # 非 Linux(无 /proc)或进程收尾,停采样


def _parse_myjavis_brain(raw: str) -> dict[str, str] | None:
    """解析 dispatch metadata 里的 MyJavis 共脑指引(A 方案,2026-07-16)。

    MyJavis App 签的 token 在 RoomAgentDispatch.metadata 带
    ``{"myjavis": {"session": <房名>, "tenant": <租户id>}}``——本 worker 据此把
    LLM 指回 MyJavis CustomLLM 端点(记忆/人设/视觉融合与 benchmark 同源)。
    其他入口(voice-test 页/probe)无此 metadata → None → 原大脑零变化。
    只认字符串字段,缺一即弃(fail fast 到默认大脑,不半配置运行)。
    """
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return None
    brain = data.get("myjavis") if isinstance(data, dict) else None
    if not isinstance(brain, dict):
        return None
    session, tenant = brain.get("session"), brain.get("tenant")
    if isinstance(session, str) and session and isinstance(tenant, str) and tenant:
        return {"session": session, "tenant": tenant}
    return None


class TierACascadeEngine(ExperienceEngine):
    tier: ClassVar[Tier] = Tier.A_CASCADE

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._queue: asyncio.Queue[EngineEvent | None] = asyncio.Queue()
        self._session: object | None = None
        self._livekit_started = False
        self._rss_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if not self._livekit_started:
            await self._queue.put(None)
        return None

    async def events(self) -> AsyncIterator[EngineEvent]:
        while True:
            item = await self._queue.get()
            if item is None:
                break
            yield item

    async def inject_context(self, context: str) -> None:
        # M1: 将记忆 Context 注入 AgentSession 的 system / chat_ctx。
        _ = context
        return None

    async def aclose(self) -> None:
        # RSS 采样任务回收(悬挂 task 会拖 entrypoint 收尾)
        rss_task = getattr(self, "_rss_task", None)
        if rss_task is not None:
            rss_task.cancel()
            self._rss_task = None
        # 先取消音乐播放任务——否则播放任务(流一首 4 分钟的歌)不退出,同样导致
        # "entrypoint did not exit in time" → 房间删不干净 → 用户第二次进不去
        # (2026-07-04 川哥实测:播放音乐后断开,第二次连不上)。
        with suppress(Exception):
            from ..tools.music_playback import stop_all_playback

            stop_all_playback()
        # 再放哨兵解开 VoiceSession.run() 的事件循环,再关 AgentSession——反过来的话
        # AgentSession 在异常态(如 TTS 流水线崩溃后)aclose 可能卡死,shutdown 回调
        # 超时 → "entrypoint did not exit in time" 强杀(2026-07-02 川哥实测复发根因)。
        await self._queue.put(None)
        session = self._session
        self._session = None
        if session is not None:
            close = getattr(session, "aclose", None)
            if close is not None:
                with suppress(Exception):
                    await asyncio.wait_for(close(), timeout=5.0)
        return None

    async def start_livekit_job(self, ctx: Any) -> None:
        """启动真实 LiveKit 会话并注册 M0 事件桥。

        这条路径需要 ``LIVEKIT_*``、STT/LLM/TTS provider 真值以及 LiveKit CLI 环境。
        无真值的单元测试仍走 ``start/events/aclose`` 的纯逻辑路径。
        """
        import importlib
        import os

        agents_mod = importlib.import_module("livekit.agents")
        silero = importlib.import_module("livekit.plugins.silero")
        Agent = agents_mod.Agent
        AgentSession = agents_mod.AgentSession
        inference = agents_mod.inference  # 本地音频 EOT(turn-detector-v1-mini)

        await ctx.connect()  # 先连入 room,ctx.room 才可用

        room_input = agents_mod.RoomInputOptions

        # 复用 setup_fnc 预载的 VAD(proc.userdata);无(直跑/旧入口)则现场加载
        vad = None
        proc = getattr(ctx, "proc", None)
        if proc is not None:
            vad = proc.userdata.get("vad")
        if vad is None:
            vad = _load_vad(silero)

        # 声纹旁路(Phase 1,默认关):ring 挂 STT pump,sidecar 挂 turn 钩子
        speaker_sidecar = _load_speaker_sidecar(proc)

        # A 方案共脑(2026-07-16):MyJavis 签的 dispatch metadata 带 session/tenant →
        # LLM 指回 MyJavis CustomLLM;其他入口 None → 原大脑零变化。
        myjavis_brain = _parse_myjavis_brain(
            getattr(getattr(ctx, "job", None), "metadata", "") or ""
        )
        if myjavis_brain is not None:
            logger.info(
                "myjavis brain engaged: session=%s tenant=%s",
                myjavis_brain["session"],
                myjavis_brain["tenant"][:8],
            )

        # 租户大脑按用户读记忆(2026-07-29):participant identity(=前端 connect 的
        # participantName,激活码)随每次 LLM 请求以 OpenAI 标准 user 字段透传。
        # 仅 tenant-brain 需要;dispatch 由用户 join 触发,正常立即返回,10s 超时兜底降级。
        participant_identity = ""
        if self._settings.llm_provider == "tenant-brain":
            try:
                p = await asyncio.wait_for(ctx.wait_for_participant(), timeout=10)
                participant_identity = p.identity or ""
                logger.info("tenant-brain user identity: %s", participant_identity)
            except asyncio.TimeoutError:
                logger.warning("等 participant 超时,本 job 不透传 user(记忆退化为无身份)")

        session = AgentSession(
            stt=_build_stt(
                self._settings,
                speaker_ring=speaker_sidecar.ring if speaker_sidecar is not None else None,
            ),
            # P2:声纹粘滞身份注入 LLM 近因位(sidecar 关闭时为 None=零变化)
            llm=_build_llm(
                self._settings,
                context_note_provider=(
                    speaker_sidecar.context_note if speaker_sidecar is not None else None
                ),
                myjavis_brain=myjavis_brain,
                participant_identity=participant_identity,
            ),
            tts=_build_tts(self._settings),
            vad=vad,
            # 语义判停:本地音频 EOT(纯 native .so,零下载零认证)。钉死 v1-mini——
            # 不钉则默认值遇 is_dev_mode()/is_hosted() 环境会切 v1(livekit cloud)→401;
            # 与 sherpa endpoint 叠加:v1-mini 精修判停时机,sherpa FINAL 仍负责把文本交 LLM。
            # POC 预测式判停(2026-07-29):unlikely_threshold 可 env 覆盖服务端校准值——
            # 概率<阈值→走 MAX 等待,故**调低=更激进**(更多句直接走 MIN 快路)。
            # 未设=完全原行为。配套激进 delay 见 MIN/MAX_ENDPOINTING_DELAY 注释。
            turn_detection=inference.TurnDetector(
                version="v1-mini",
                **(
                    {"unlikely_threshold": float(os.environ["POC_EOU_UNLIKELY_THRESHOLD"])}
                    if os.environ.get("POC_EOU_UNLIKELY_THRESHOLD")
                    else {}
                ),
            ),
            # preemptive_generation=True:投机跑 LLM(不含 TTS)。
            # ⚠️ 2026-06-25 回退 preemptive_tts=True:川哥实测"延时没改善还断断续续"——
            # 投机 TTS 片段与正式片段拼接在 VoxCPM 非流式下撕裂(codex 早警告的风险坐实)。
            # 真正的连续+流式留给 CosyVoice2(真流式);VoxCPM 阶段只投机 LLM 不投机 TTS。
            preemptive_generation=True,
            # 🔴 漏词根因(2026-06-25 worker 日志实证 "eou ran after turn flushed / late stt final"):
            # min 0.15 太低→判"说完"就 0.15s 提交,但 sherpa STT FINAL 要等 rule2 0.4s 静音才发
            # →EOU 抢在 FINAL 前提交→句尾词被丢=漏词。硬约束:判停不能早于 STT FINAL。
            # A3(2026-07-02)默认 0.4→0.55:火山 end_window=200 时尾句 definite 在停说后
            # ~350-550ms 到;0.4 与其上界倒挂→HK worker 日志仍偶发同款 WARNING(自动路径无
            # interim 兜底,audio_recognition on_end_of_turn 只带 FINAL 累积,尾句真丢+v1-mini
            # 语义判停被 skip)。0.55 覆盖上界;+150ms 判停成本由 S1 v3 投机(-400~650ms)覆盖。
            min_endpointing_delay=float(os.environ.get("MIN_ENDPOINTING_DELAY", "0.55")),
            # 源码实证(audio_recognition.py:1504 extra_sleep=delay+(last_speaking_time-now)):
            # EOU commit 恰在「停说+endpointing_delay」,STT 静音已被吸收非叠加→判停≈此 delay。
            # max≥min;env 化(默认 0.6)。B 方案(hybrid 重聚合)拉大到 ~1.5s:turn detector 判
            # "句中没说完"时延到此值等下一句 definite 累积重聚合(不切碎);判"说完"用 min 快提交。
            # ⚠️命门=turn detector 中文判准:句末误判"没说完"→等满此值反而变慢。
            max_endpointing_delay=float(os.environ.get("MAX_ENDPOINTING_DELAY", "0.6")),
            allow_interruptions=True,
            resume_false_interruption=True,
            # P0 环境音防误打断三参数(2026-07-17 川哥"容易被环境音打断";全 env 可调=回滚
            # 设计,设回 0/0.5/2.0 即恢复旧行为):
            # ①字数门(核心):VAD 触发打断时 ASR interim 无字 → 不打断继续播(框架对中文按
            #   字切;final 路径同款检查,agent 说话中的无字 turn 被整体丢弃)。出不了字的环境
            #   音(关门/键盘/配乐/咳嗽)全免疫。
            #   v2(2026-07-17 川哥真机"插话慢很多"):2→1——插话打断=AEC 保护窗 0.5s(静音替
            #   代送 STT)+interim 等字+时长门三层叠加 1.2-1.5s;等首字不等两字省一截,防护
            #   几乎不降(主力防护是"出不了字"层,误识别出整字的环境音 1/2 字门都拦不全)。
            min_interruption_words=int(os.environ.get("MIN_INTERRUPTION_WORDS", "1")),
            # ②时长门:v2 退回 0.5 默认——字数门已管内容,0.7 的 +0.2s 在真插话是纯延迟叠加。
            min_interruption_duration=float(os.environ.get("MIN_INTERRUPTION_DURATION", "0.5")),
            # ③假打断恢复窗 2.0→1.5:漏网假打断更快续播(打断后该窗内无词=假打断自动恢复)。
            false_interruption_timeout=float(os.environ.get("FALSE_INTERRUPTION_TIMEOUT", "1.5")),
            # 🔴 ASR 吃首字根因①(2026-07-04 源码实证 agent_activity.push_audio):
            # AEC warmup(默认 3.0s,首次 agent 说话起 one-shot)期间 agent_state=speaking
            # 时,喂 STT 的用户音频被替换成**纯静音**(VAD 收真帧故仍可打断)——greeting
            # 没播完就抢话,说的字 ASR 根本收不到,字幕/理解都缺开头。浏览器 AEC 收敛
            # 实际 <300ms,压到 0.5s:极早抢话仍受保护,常规抢话不再吃字。
            aec_warmup_duration=float(os.environ.get("AEC_WARMUP_DURATION", "0.5")),
        )
        self._session = session
        self._livekit_started = True
        # 急停白名单直通(P0 2026-07-17):字数门 min_interruption_words=2 的盲区=单字
        # "停"(意图最强、长度最短)。转写标准化后**精确命中**词表 → 绕过字数门手动打断。
        # 仅 agent 说话中触发;interim 重复命中无害(interrupt 幂等,二次触发时已非 speaking)。
        # INTERRUPT_HOTWORDS 逗号分隔可调,设空串禁用。
        hotwords = _parse_hotwords(os.environ.get("INTERRUPT_HOTWORDS"))
        if hotwords:

            def _on_hotword_transcribed(ev: Any) -> None:
                if session.agent_state != "speaking":
                    return
                t = _normalize_utterance(getattr(ev, "transcript", "") or "")
                if t in hotwords:
                    logger.info("急停白名单命中: %r → interrupt", t)
                    session.interrupt()

            session.on("user_input_transcribed", _on_hotword_transcribed)
        # 打断遥测(2026-07-17,降噪优化数据地基):speaking→listening 转换时快照最近 interim,
        # 让"误打断率"从体感变数字——interim 有字=真插话;无字+随后契约 false_interruption=
        # 环境音穿透(已被恢复);无字+无 false=正常播完。统计:journalctl grep 'interrupt telemetry'。
        _tele_interim: dict[str, str] = {"text": ""}
        # 打断状态共享(B 2026-07-18):interim 非空的 speaking→listening=真插话打断,
        # 记时刻供 on_user_turn_completed 判定"打断轮"→filler 必播(见 _make_agent)。
        interrupt_state: dict[str, float] = {"ts": 0.0}

        def _on_tele_transcribed(ev: Any) -> None:
            _tele_interim["text"] = getattr(ev, "transcript", "") or ""

        def _on_tele_state(ev: Any) -> None:
            if (
                str(getattr(ev, "old_state", "")) == "speaking"
                and str(getattr(ev, "new_state", "")) == "listening"
            ):
                if _tele_interim["text"]:
                    interrupt_state["ts"] = time.monotonic()
                logger.info(
                    "interrupt telemetry: speaking→listening interim=%r",
                    _tele_interim["text"][:40],
                )
                _tele_interim["text"] = ""

        session.on("user_input_transcribed", _on_tele_transcribed)
        session.on("agent_state_changed", _on_tele_state)

        # --- POC 预测式判停遥测(2026-07-29,POC_PREDICTIVE_EOU=1 时挂;整块可删) ---
        # 两条日志线:①每轮 EOU 概率/阈值/延迟——⚠️ session 级 eot_prediction 事件是框架
        # 半成品(只投 LiveKit Cloud 的 _session_host,本地永不发射,实测订阅零触发),
        # 改为放行框架原生 debug 行"eot prediction"(audio_recognition logger 提 DEBUG,
        # 带 probability/unlikely_threshold/endpointing_delay 全字段);
        # ②疑似截断:commit(listening→thinking/speaking)后 <1.2s 用户又开口——配合①
        # 离线区分"真截断(高概率被续说)"vs"用户主动追问"。统计:grep 'eot prediction|poc eou'。
        if os.environ.get("POC_PREDICTIVE_EOU") == "1":
            # ⚠️ audio_recognition 等模块共用包级 logger "livekit.agents"(非模块名 logger,
            # 实测 setLevel 模块名 logger 无效);提共享 logger 到 DEBUG + Filter 只放行
            # "eot prediction" 一种 debug 消息,INFO+ 不受影响,其余 debug 噪音全拦。
            _lk_logger = logging.getLogger("livekit.agents")

            class _PocEotOnlyDebug(logging.Filter):
                # tap 转发而非放行:cli 的 JSON handler level=INFO 会拦 debug 记录
                # (实测放行到 handler 仍 0 条),故嗅到目标记录用本模块 logger 重发 INFO。
                def filter(self, record: logging.LogRecord) -> bool:
                    if record.levelno >= logging.INFO:
                        return True
                    if record.msg == "eot prediction":
                        d = record.__dict__
                        logger.info(
                            "poc eou telemetry: probability=%s threshold=%s delay=%s",
                            d.get("probability"),
                            d.get("unlikely_threshold"),
                            d.get("endpointing_delay"),
                        )
                    return False

            if not any(isinstance(f, _PocEotOnlyDebug) for f in _lk_logger.filters):
                _lk_logger.setLevel(logging.DEBUG)
                _lk_logger.addFilter(_PocEotOnlyDebug())
            _poc_commit_ts: dict[str, float] = {"ts": 0.0}

            def _on_poc_agent_state(ev: Any) -> None:
                # listening→thinking(或直接 speaking)≈ turn commit 完成时刻
                if str(getattr(ev, "old_state", "")) == "listening" and str(
                    getattr(ev, "new_state", "")
                ) in ("thinking", "speaking"):
                    _poc_commit_ts["ts"] = time.monotonic()

            def _on_poc_user_state(ev: Any) -> None:
                if str(getattr(ev, "new_state", "")) == "speaking" and _poc_commit_ts["ts"]:
                    gap = time.monotonic() - _poc_commit_ts["ts"]
                    if gap < 1.2:
                        logger.info("poc eou telemetry: truncation-suspect gap_ms=%.0f", gap * 1000)

            session.on("agent_state_changed", _on_poc_agent_state)
            session.on("user_state_changed", _on_poc_user_state)
        # RSS 采样任务(job 进程生命周期,进程退出自灭;aclose 显式回收防悬挂告警)
        self._rss_task = asyncio.create_task(_rss_monitor_loop())
        bridge = LiveKitEventBridge(emit=self._queue.put_nowait)
        _register_livekit_handlers(session, bridge)

        # 音乐工具（可选）：仅当配置了 MUSIC_ORCHESTRATOR_URL 才注册
        extra_tools: list[Any] = []
        if self._settings.music_orchestrator_url:
            try:
                import logging as _log

                from ..tools.music_client import MusicClient
                from ..tools.music_tools import create_music_tools

                mclient = MusicClient(
                    self._settings.music_orchestrator_url,
                    self._settings.music_orchestrator_key or "",
                )
                extra_tools = create_music_tools(mclient)
                _log.getLogger("voice_agent.music").info(
                    "music tools 已注册 (orchestrator=%s)", self._settings.music_orchestrator_url
                )
            except Exception:
                import logging as _logging

                _logging.getLogger("voice_agent.music").exception(
                    "music tools 注册失败，音乐能力关闭"
                )

        await session.start(
            agent=_make_agent(
                Agent,
                self._settings.agent_instructions,
                speaker_sidecar=speaker_sidecar,
                tools=extra_tools,
                interrupt_state=interrupt_state,
            ),
            room=ctx.room,
            # 统一输入采样率 16k:让 VAD 与 STT 收同采样率音频
            # (否则 VAD 收原始 RTC 48k 自重采样劣化→silero 不触发→turn 不提交)
            # 🔴 重连修 v2(2026-07-02 两轮实测定稿):agent dispatch 只在 room **创建时**
            # 发生,空房默认存活 300s——旧问题=断开后重连进"无 agent 的旧房"。
            # v1 曾试 close_on_disconnect=False 留守 45s:真实场景(完整对话 + TTS 异常)
            # 下留守 agent 对重连的新 participant 挂流不可靠,"房里有 agent 但聋了"更难查,
            # 已回退。定稿=简单模型:用户断开 → 立即关 session(close_on_disconnect 默认
            # True)→ delete_room_on_close=True 删房(秒级)→ 用户再连必新房必新 agent
            # 必有 greeting。5G 闪断 resume 不受影响(resume 不算 disconnect)。
            room_input_options=room_input(
                audio_sample_rate=16000,
                delete_room_on_close=True,
            ),
            # ⚠️ 回退:room_output_options(dtx=False/red=True) 致浏览器 livekit-client WS 升级后
            # 连接 reset(python client 能协商 RED 但浏览器协商失败)。dtx/red 跨境优化改走客户端侧。
        )
        _register_metrics(session, ctx, agents_mod)  # 链路延迟 → web 页面板
        if os.environ.get("GREETING_MODE", "fixed") == "llm":
            # 开场白走 LLM(2026-07-28 租户诉求:欢迎语也由租户提示词体系生成)——
            # 指令走 **user_input 位**(非 instructions):instructions 只生成 system-only
            # 请求,严格端点(DashScope 20015/Gemini vertex)都拒"无 user 消息";user 位
            # 全兼容,租户端点还可识别这条固定开场指令定制开场。失败不挡主链路。
            hint = os.environ.get(
                "GREETING_LLM_HINT",
                "(用户刚接通语音通话。请按你的人设自然地打个招呼,一句话,10字以内。)",
            )
            try:
                session.generate_reply(user_input=hint)
            except Exception:
                logger.exception("LLM 开场白失败(降级静默,用户开口即正常对话)")
        elif self._settings.agent_greeting:
            # 固定问候语直接 TTS 念(say),不走 LLM——generate_reply(instructions=)
            # 在 Gemini vertex-ai 上因无 user turn 报 400 "input cannot be empty"。
            await session.say(self._settings.agent_greeting)


# --- 急停白名单(P0 环境音防误打断,2026-07-17) ---------------------------------

# 默认急停词(精确匹配,非包含——"停车场怎么走"不触发):打断意图明确的短词,
# 其中单字"停/等"正是字数门(min_interruption_words=2)按长度误杀的对象。
_DEFAULT_INTERRUPT_HOTWORDS = "停,停停,停下,停一下,等等,等一下,别说了,别说,闭嘴,安静"
# ASR 转写常带尾标点与空格("停。"≠"停"会漏),标准化后再比对
_HOTWORD_STRIP_RE = re.compile(r"[\s，。！？!?.、~～…]+")


def _normalize_utterance(text: str) -> str:
    """转写标准化:去空白与常见中英标点,供急停词精确比对。"""
    return _HOTWORD_STRIP_RE.sub("", text or "")


def _parse_hotwords(raw: str | None) -> frozenset[str]:
    """INTERRUPT_HOTWORDS 逗号分隔 → 标准化词集;显式设空串=禁用白名单。"""
    src = _DEFAULT_INTERRUPT_HOTWORDS if raw is None else raw
    return frozenset(w for w in (_normalize_utterance(p) for p in src.split(",")) if w)


def _load_vad(silero: Any) -> Any:
    """silero VAD 加载(setup_fnc 预热与 job 内兜底共用)。

    - min_silence 0.3:静音多久判 EOS(判停固定开销;v1-mini 语义兜底防切碎)。
    - activation_threshold 0.6(门控,治背景误触发 2026-06-29):远场/低置信声音不算
      speech。⚠️调太高漏听小声/远场的孩子。silero 默认 0.5。
    - min_speech_duration 0.15:滤短促噪声(咳嗽/碰撞)。⚠️调太高滤掉"嗯/好/对"。
    """
    import os

    return silero.VAD.load(
        min_silence_duration=0.3,
        activation_threshold=float(os.environ.get("VAD_ACTIVATION_THRESHOLD", "0.6")),
        min_speech_duration=float(os.environ.get("VAD_MIN_SPEECH_DURATION", "0.15")),
    )


def setup_process(proc: Any) -> None:
    """AgentServer ``setup_fnc``:idle 子进程初始化时预载 silero VAD。

    2026-07-02 HK 实测:restart 后**首个 job 必崩**——FFI panic "timed out waiting for
    ReadyForRoomEventRequest after ConnectCallback"。根因=2 核机上 job 进程内 silero onnx
    冷加载阻塞 event loop,ctx.connect 的 room 事件握手超时。预载后 job 到来时模型已就绪。
    """
    import importlib

    silero = importlib.import_module("livekit.plugins.silero")
    proc.userdata["vad"] = _load_vad(silero)
    # openai 惰性 import 税的兜底预载(真根因与终解见 _openai_preload 模块文档):
    # Linux 生产走 forkserver preload,此处 import 命中缓存零成本;macOS/spawn 开发
    # 环境无 preload,由这里付清——否则 job 进程 prewarm 协程首次访问 client.chat
    # 触发 pydantic 建模(1s+ CPU 持 GIL),饿死 ctx.connect 的 FFI ready 握手(rust
    # 1s deadline)→ panic(2026-07-03 py-spy 栈实锤;补位进程 initialize 实测仅
    # 84ms,是同秒出现的旁观者非真凶)。
    importlib.import_module("voice_agent.engines._openai_preload")
    # 声纹旁路 extractor 预载:**后台线程 + 延迟错峰**,不在 setup 同步做。
    # 🔴 2026-07-03 HK 实测竞态:job 分配的同一瞬间主进程 spawn 补位 idle 进程,
    # 若补位进程 setup 同步载 27MB onnx(0.9-1.1s),2 核上与 job 进程的 FFI 握手
    # (ReadyForRoomEventRequest,~1s 超时)抢 CPU → job ~50% 概率 FFI panic 秒崩。
    # 错峰后补位初始化回到轻量;延迟窗内 job 到来 → userdata 未就绪 → 该 job 旁路
    # 禁用(零伤害)。观测用 stderr print(setup/线程阶段 logging 可能未接转发管道)。
    import sys
    import threading
    import time as _time

    cfg = _speaker_id_env()
    if cfg is None:
        print("[speaker_id] setup: 未启用(SPEAKER_ID_ENABLED!=1)", file=sys.stderr, flush=True)
        return
    if not cfg[0].is_file():
        print(f"[speaker_id] setup: 模型不存在 {cfg[0]}", file=sys.stderr, flush=True)
        return
    holder: dict[str, Any] = {}
    proc.userdata["speaker_extractor_holder"] = holder
    model_path = cfg[0]

    def _bg_load() -> None:
        _time.sleep(4.0)  # 错峰:让同时刻的 job FFI 握手先走完
        try:
            from .speaker_id import load_extractor

            _t0 = _time.perf_counter()
            holder["extractor"] = load_extractor(model_path)
            print(
                f"[speaker_id] setup: extractor 后台预载完成 {_time.perf_counter() - _t0:.2f}s",
                file=sys.stderr,
                flush=True,
            )
        except Exception as exc:  # 预载失败只降级旁路,绝不影响进程
            print(f"[speaker_id] setup: 后台预载失败 {exc!r}", file=sys.stderr, flush=True)

    threading.Thread(target=_bg_load, daemon=True, name="speaker-preload").start()


def _speaker_id_env() -> tuple[Path, Path, float] | None:
    """声纹旁路 env 解析:SPEAKER_ID_ENABLED=1 → (模型路径, 注册库路径, 阈值);否则 None。

    Phase 1(docs/VOICEPRINT-PLAN.md):默认关;模型=CAM++ zh-cn 26MB(assets/models),
    注册库=assets/speakers/registry.json(scripts/enroll_speaker.py 生成,不进 git)。
    """
    import os
    from pathlib import Path

    if os.environ.get("SPEAKER_ID_ENABLED", "0") != "1":
        return None
    root = Path(__file__).resolve().parents[3]
    model = Path(
        os.environ.get(
            "SPEAKER_ID_MODEL",
            str(root / "assets" / "models" / "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"),
        )
    )
    registry = Path(
        os.environ.get("SPEAKER_ID_REGISTRY", str(root / "assets" / "speakers" / "registry.json"))
    )
    threshold = float(os.environ.get("SPEAKER_ID_THRESHOLD", "0.6"))
    return model, registry, threshold


def _load_speaker_sidecar(proc: Any) -> Any:
    """声纹旁路装配(job 内调用)。启用条件:env 开 + 模型在 + 注册库非空;
    任何一环不满足或异常 → None 静默降级,绝不影响主链路。"""
    import logging

    log = logging.getLogger("voice_agent.speaker_id")
    try:
        cfg = _speaker_id_env()
        if cfg is None:
            return None
        model, registry_path, threshold = cfg
        if not model.is_file():
            log.warning("speaker id: 模型不存在 %s,旁路关闭", model)
            return None
        if not registry_path.is_file():
            log.info("speaker id: 注册库不存在 %s(先跑 enroll_speaker.py),旁路关闭", registry_path)
            return None
        from .speaker_id import (
            AudioRingBuffer,
            SpeakerIdentifier,
            SpeakerIdSidecar,
            load_registry,
        )

        holder = proc.userdata.get("speaker_extractor_holder") if proc is not None else None
        extractor = holder.get("extractor") if holder else None
        if extractor is None:
            # 🔴 铁律:job 内绝不同步加载 onnx(阻塞 event loop → FFI panic job 必崩;
            # 预载在 setup 后台线程延迟 4s 错峰跑)。未就绪/缺失 → 本 job 旁路禁用。
            log.warning("speaker id: extractor 预载未就绪/缺失,本 job 旁路禁用")
            return None
        profiles = load_registry(registry_path, expected_dim=int(extractor.dim))
        if not profiles:
            log.warning("speaker id: 注册库为空/维度全不匹配,旁路关闭")
            return None
        import os

        dump_env = os.environ.get("SPEAKER_ID_DUMP_DIR", "")
        sidecar = SpeakerIdSidecar(
            AudioRingBuffer(),
            SpeakerIdentifier(extractor, profiles, threshold),
            dump_dir=Path(dump_env) if dump_env else None,
        )
        log.info("speaker id: 旁路启用(%d 人注册,threshold=%.2f)", len(profiles), threshold)
        return sidecar
    except Exception:
        log.warning("speaker id: 旁路装配失败(关闭,不影响主链路)", exc_info=True)
        return None


def _require(value: str | None, name: str) -> str:
    if not value:
        raise RuntimeError(f"{name} 不能为空：M0 本地栈需要该配置")
    return value


def _build_stt(settings: Settings, *, speaker_ring: Any | None = None) -> Any:
    """按 ``STT_PROVIDER`` 构建真实 STT 插件实例(M0:本地 sherpa-onnx)。

    ``speaker_ring``:声纹旁路 ring buffer(仅 volc 分支接线;Phase 1 生产=volc)。
    """
    provider = settings.stt_provider
    if provider == "sherpa":
        from .sherpa_stt import SherpaSTT, build_sherpa_recognizer

        model_dir = _require(settings.stt_model_dir, "STT_MODEL_DIR")
        return SherpaSTT(build_sherpa_recognizer(model_dir))
    if provider == "volc":
        # 火山豆包在线流式 ASR(服务端内置语义判停,解切碎);凭据 env 注入
        import os

        from .volc_stt import VolcSTT

        # VOLC_ASR_API_KEY 设了走新版单 key 鉴权(seedasr 2.0 必须);否则旧版 app_id+token
        # (bigasr 1.0)。TTS 仍用 VOLC_APP_ID/VOLC_ACCESS_TOKEN(旧版),与 ASR 凭据解耦。
        _asr_api_key = os.environ.get("VOLC_ASR_API_KEY") or None
        return VolcSTT(
            app_id=os.environ.get("VOLC_APP_ID", ""),
            access_token=os.environ.get("VOLC_ACCESS_TOKEN", ""),
            api_key=_asr_api_key,
            resource_id=os.environ.get("VOLC_ASR_RESOURCE_ID", "volc.bigasr.sauc.duration"),
            # 句末静音判停窗(ms):默认 800 把火山判停从 ≈2900ms 压到 ~0.8s(task #30)。
            end_window_size=int(os.environ.get("VOLC_ASR_END_WINDOW_MS", "800")),
            # S1 v3 投机重叠:用户音频静音 + interim 文本静止双条件 emit PREFLIGHT,
            # 触发 preemptive 提前跑 LLM 藏进判停。VOLC_PREFLIGHT_ENABLED=0 关(回滚)。
            preflight_enabled=os.environ.get("VOLC_PREFLIGHT_ENABLED", "1") == "1",
            # 连续静音多少 ms 触发(过小→说话辅音间隙误触发烧 token;过大→投机窗缩水)
            preflight_silence_ms=float(os.environ.get("VOLC_PREFLIGHT_SILENCE_MS", "180")),
            # 尾句 interim 文本需静止多少 ms(防 STT 还在修正中途投机)
            preflight_text_quiet_ms=float(os.environ.get("VOLC_PREFLIGHT_TEXT_QUIET_MS", "150")),
            # 静音幅度阈值(PCM16 mean-abs):说话 ~1000+,底噪 <~200;底噪重环境可调高
            preflight_silence_amp=float(os.environ.get("VOLC_PREFLIGHT_SILENCE_AMP", "250")),
            speaker_ring=speaker_ring,
            # 语义顺滑(2026-07-04 team 圆桌定案,grok+codex 共识):火山服务端默认 False,
            # 我们 vendored 客户端签名默认 True——之前从未显式决定过,现改为显式产品策略。
            # 顺滑会删语气词/停顿词/重复词("嗯/哦/咳咳"),陪伴场景利大于弊(字幕干净+
            # AI 不回应咳嗽),但需配 volc_stt._emit 里的空 final 告警兜底(见该文件注释)。
            enable_ddc=os.environ.get("VOLC_ASR_ENABLE_DDC", "1") == "1",
        )
    if provider == "xfyun":
        # 讯飞大模型实时转写(租户 provider,2026-07-27):凭据优先租户加密存储
        # (每 job 读,改 key 热生效),缺租户上下文回退 env 直配(本机调试)。
        import os

        from voice_agent.tenant import load_tenant_credentials

        from .xfyun_stt import XfyunSTT

        creds = load_tenant_credentials("xfyun_stt") or {
            "app_id": os.environ.get("XFYUN_STT_APP_ID", ""),
            "access_key_id": os.environ.get("XFYUN_STT_ACCESS_KEY_ID", ""),
            "access_key_secret": os.environ.get("XFYUN_STT_ACCESS_KEY_SECRET", ""),
        }
        missing = [k for k in ("app_id", "access_key_id", "access_key_secret") if not creds.get(k)]
        if missing:
            raise RuntimeError(f"xfyun STT 凭据缺失 {missing}:租户未写入且 env 未配")
        return XfyunSTT(
            app_id=creds["app_id"],
            access_key_id=creds["access_key_id"],
            access_key_secret=creds["access_key_secret"],
        )
    if provider == "xfyun_spark_iat":
        # 讯飞中文识别大模型(对话线,eos 静音断句解碎句,2026-07-28 替代 xfyun 转写线)
        import os

        from voice_agent.tenant import load_tenant_credentials

        from .xfyun_spark_iat import XfyunSparkIatSTT

        creds = load_tenant_credentials("xfyun_spark_iat") or {
            "app_id": os.environ.get("XFYUN_IAT_APP_ID", ""),
            "api_key": os.environ.get("XFYUN_IAT_API_KEY", ""),
            "api_secret": os.environ.get("XFYUN_IAT_API_SECRET", ""),
        }
        missing = [k for k in ("app_id", "api_key", "api_secret") if not creds.get(k)]
        if missing:
            raise RuntimeError(f"spark iat 凭据缺失 {missing}:租户未写入且 env 未配")
        return XfyunSparkIatSTT(
            app_id=creds["app_id"],
            api_key=creds["api_key"],
            api_secret=creds["api_secret"],
            # eos:服务端静音断句窗(碎句解药);amp:说话检测幅度门(回合制开会话)
            eos_ms=int(os.environ.get("XFYUN_IAT_EOS_MS", "700")),
            speech_amp=float(os.environ.get("XFYUN_IAT_SPEECH_AMP", "250")),
        )
    raise RuntimeError(
        f"未知 STT_PROVIDER={provider!r}（支持：sherpa/volc/xfyun/xfyun_spark_iat）"
    )


def _build_llm(
    settings: Settings,
    *,
    context_note_provider: Any | None = None,
    myjavis_brain: dict[str, str] | None = None,
    participant_identity: str = "",
) -> Any:
    """按 ``LLM_PROVIDER`` 构建 LLM(M0:OpenAI 兼容端点,接 Gemini proxy)。

    ``context_note_provider``:每请求动态上下文(P2 声纹身份),仅 FastLLM 路径支持。
    ``myjavis_brain``:A 方案共脑(2026-07-16)——非 None 时 LLM 指向 MyJavis CustomLLM
    端点(session/tenant 走 default_query),记忆/人设/视觉融合与其 benchmark 链路同源。
    """
    import importlib
    import os

    if myjavis_brain is not None:
        from .fast_llm import FastLLM

        return FastLLM(
            model="myjavis-brain",  # 端点自选模型(内部 race),此值仅日志标识
            # 同机 localhost 直连(免公网绕行);鉴权 key 在 worker env(dispatch metadata
            # 在 JWT 里客户端可解码,绝不经它传 key)。
            base_url=os.environ.get("MYJAVIS_LLM_URL", "http://127.0.0.1:3001/v1"),
            api_key=os.environ.get("MYJAVIS_LLM_API_KEY", "") or "sk-noauth",
            thinking="off",  # 端点非 DeepSeek 直连,thinking body 由端点内部处理
            default_query={"session": myjavis_brain["session"], "tenant": myjavis_brain["tenant"]},
            # 不配 fallback:端点内部已有双 provider race,再套一层是浪费。
            # 声纹身份注入不传:端点只取 user/assistant 消息,system 注入会被滤掉(白费带宽);
            # MyJavis 侧租户即身份(solo 模式),共脑下身份由端点自己的体系负责。
            strip_leading_filler=os.environ.get(
                "LLM_STRIP_LEADING_FILLER", os.environ.get("FILLER_ENABLED", "1")
            )
            == "1",
        )

    provider = settings.llm_provider
    if provider in {"openai", "gemini"}:
        model = _require(settings.llm_model, "LLM_MODEL")
        base_url = _require(settings.llm_base_url, "LLM_BASE_URL")
        api_key = settings.llm_api_key or "sk-noauth"
        # 默认 vendored FastLLM(httpx 直发,TTFT 600-1100→~200-330ms,详见 fast_llm.py);
        # LLM_FAST_CLIENT=0 回退官方 openai.LLM(出问题时止损)。
        if os.environ.get("LLM_FAST_CLIENT", "1") == "1":
            from .fast_llm import FastLLM

            # DeepSeek v4 默认关思考(实时语音要快);LLM_THINKING=enabled/adaptive 可开
            return FastLLM(
                model=model,
                base_url=base_url,
                api_key=api_key,
                thinking=os.environ.get("LLM_THINKING", "disabled"),
                # gemma4 接 Studio 本地走 ollama /api/chat(关思考);DeepSeek 默认 openai。
                api_style=os.environ.get("LLM_API_STYLE", "openai"),
                num_ctx=int(os.environ.get("LLM_NUM_CTX", "8192")),
                # R1 赛马兜底(2026-07-03):LLM_FALLBACK_* 三项配齐即开双路赛马
                # (解 DeepSeek 晚高峰 1.3-40s 抖动)。MiniMax M 系 think 混 content,
                # 默认剥(LLM_FALLBACK_STRIP_THINK=0 关,换干净 provider 时用)。
                fallback_model=os.environ.get("LLM_FALLBACK_MODEL", ""),
                fallback_base_url=os.environ.get("LLM_FALLBACK_BASE_URL", ""),
                fallback_api_key=os.environ.get("LLM_FALLBACK_API_KEY", ""),
                fallback_thinking=os.environ.get("LLM_FALLBACK_THINKING", "off"),
                fallback_strip_think=os.environ.get("LLM_FALLBACK_STRIP_THINK", "1") == "1",
                context_note_provider=context_note_provider,
                # 剥回复开头承接词(R2 v2,2026-07-04):跟随承接音开关——承接音已
                # "嗯"过,正文再"嗯"是结巴;承接音关闭时正文语气词自然,保留。
                # 在 LLM 输出层剥,TTS/字幕/历史一致(旧 TTS 句级剥致字幕比音频多字)。
                strip_leading_filler=os.environ.get(
                    "LLM_STRIP_LEADING_FILLER", os.environ.get("FILLER_ENABLED", "1")
                )
                == "1",
            )
        openai = importlib.import_module("livekit.plugins.openai")
        return openai.LLM(model=model, base_url=base_url, api_key=api_key)
    if provider == "tenant-brain":
        # 模式 B(2026-07-27):大脑归租户——LLM 指向同事自己的 OpenAI 兼容端点,
        # prompt/记忆/工具全在他侧;我们只管耳(STT)嘴(TTS)喉(编排/门控/filler)。
        # 结构与 myjavis_brain 共脑同构;不配 fallback(他端点的可用性归他)。
        from voice_agent.tenant import load_tenant_credentials

        from .fast_llm import FastLLM

        creds = load_tenant_credentials("brain")
        if not creds:
            raise RuntimeError("tenant-brain: 租户未写入 brain 凭据(POST /v1/credentials)")
        return FastLLM(
            model=creds.get("model") or "default",
            base_url=creds["base_url"],
            api_key=creds["api_key"],
            # participant identity 原样透传(OpenAI 标准 user 字段)→ 租户按用户读记忆
            user=participant_identity,
            thinking="off",
            strip_leading_filler=os.environ.get(
                "LLM_STRIP_LEADING_FILLER", os.environ.get("FILLER_ENABLED", "1")
            )
            == "1",
        )
    raise RuntimeError(f"未知 LLM_PROVIDER={provider!r}（M0 支持：openai/gemini/tenant-brain）")


def _build_tts(settings: Settings) -> Any:
    """按 ``TTS_PROVIDER`` 构建真实 TTS 插件实例(M0:本地 VoxCPM2)。"""
    provider = settings.tts_provider
    if provider == "voxcpm":
        from .voxcpm_tts import VoxCPMTTS, load_voxcpm_model

        model_dir = _require(settings.tts_model_dir, "TTS_MODEL_DIR")
        return VoxCPMTTS(load_voxcpm_model(model_dir))
    if provider == "volc":
        # 火山豆包在线双向流式 TTS(固定音色+真流式,解音色随机/非流式);凭据 env 注入
        import importlib
        import os

        from .volc_tts import VolcTTS

        volc = VolcTTS(
            app_id=_require(os.environ.get("VOLC_APP_ID"), "VOLC_APP_ID"),
            access_token=_require(os.environ.get("VOLC_ACCESS_TOKEN"), "VOLC_ACCESS_TOKEN"),
            speaker=os.environ.get("VOLC_TTS_SPEAKER", "zh_female_vv_uranus_bigtts"),
            resource_id=os.environ.get("VOLC_TTS_RESOURCE_ID", "seed-tts-2.0"),
            speed_ratio=float(os.environ.get("VOLC_TTS_SPEED", "1.15")),
        )
        # 🔴 首句提速关键(2026-07-02 HK 实锤):不自己包 StreamAdapter 时,官方默认
        # blingfire min_sentence_len=20(agent.py:507)——中文短首句(如"稍等,我查一下。"
        # 8 字)被攒到 ≥20 字才 flush 给 TTS,首段 TTS 输入被拖成前两句,开口慢 ~500-800ms。
        # 自己包 + min_len 6:8 字首句立即 flush;不设更小(首段播放时长须 > 下段 TTS
        # 建连 ~700ms,否则句间断音;6 字 ≈1.2s+ 播放,安全)。
        agents_mod = importlib.import_module("livekit.agents")
        min_sent = int(os.environ.get("TTS_MIN_SENTENCE_LEN", "6"))
        return agents_mod.tts.StreamAdapter(
            tts=volc,
            sentence_tokenizer=agents_mod.tokenize.blingfire.SentenceTokenizer(
                retain_format=True, min_sentence_len=min_sent
            ),
        )
    if provider == "xfyun":
        # 讯飞超拟人合成(租户 provider):凭据同 STT 策略,vcn 随凭据可选字段
        import os

        from voice_agent.tenant import load_tenant_credentials

        from .xfyun_tts import DEFAULT_VCN, XfyunTTS

        creds = load_tenant_credentials("xfyun_tts") or {
            "app_id": os.environ.get("XFYUN_TTS_APP_ID", ""),
            "api_key": os.environ.get("XFYUN_TTS_API_KEY", ""),
            "api_secret": os.environ.get("XFYUN_TTS_API_SECRET", ""),
            "vcn": os.environ.get("XFYUN_TTS_VCN", ""),
        }
        missing = [k for k in ("app_id", "api_key", "api_secret") if not creds.get(k)]
        if missing:
            raise RuntimeError(f"xfyun TTS 凭据缺失 {missing}:租户未写入且 env 未配")
        return XfyunTTS(
            app_id=creds["app_id"],
            api_key=creds["api_key"],
            api_secret=creds["api_secret"],
            vcn=creds.get("vcn") or DEFAULT_VCN,
        )
    raise RuntimeError(f"未知 TTS_PROVIDER={provider!r}（支持：voxcpm/volc/xfyun）")


def _load_filler_bank() -> Any:
    """加载语义分桶承接音库(C1 v2,详见 engines/fillers.py 模块文档)。
    FILLER_ENABLED=0 / 资产缺失 → None(静默降级,不影响主链路)。"""
    import os
    from pathlib import Path

    from .fillers import FillerBank

    if os.environ.get("FILLER_ENABLED", "1") != "1":
        return None
    default_dir = Path(__file__).resolve().parents[3] / "assets" / "fillers"
    filler_dir = Path(os.environ.get("FILLER_DIR", str(default_dir)))
    # v5.2 定位升级(2026-07-17 川哥拍板 0.9):filler 不是调味料,是**感知响应速度的
    # 核心机制**——预缓存音频零合成延迟,用户停口即出声,把 LLM+TTS 等待藏进衔接语。
    # 高频的前提是自然(9 桶语义选桶+62 条变体+滑窗 3 防重复),不自然改文案不降频。
    probability = min(1.0, float(os.environ.get("FILLER_PROBABILITY", "0.9")))
    return FillerBank.load(filler_dir, probability)


def _make_agent(
    agent_cls: Any,
    instructions: str,
    *,
    speaker_sidecar: Any | None = None,
    tools: list[Any] | None = None,
    interrupt_state: dict[str, float] | None = None,
) -> Any:
    """构造带承接音的 Agent 子类实例(C1 v2,2026-07-02 川哥反馈迭代)。

    ``on_user_turn_completed`` 是唯一同时满足两条件的钩子:①拿到用户 turn 完整文本
    (语义选桶)②执行在回复 speech 排队之前(say 的承接句排队在回复前,同轨串行,
    播完自然衔接回复;官方 docstring 明示此处可 say canned message)。
    say(add_to_chat_ctx=False):承接句不进对话历史,不污染 LLM 上下文。
    ``speaker_sidecar``:声纹旁路,同钩子消费本轮音频(fire-and-forget,内部吞异常)。
    """
    from .fillers import FillerBank

    bank = _load_filler_bank()

    class _FillerAgent(agent_cls):  # type: ignore[misc, valid-type]
        async def on_user_turn_completed(self, turn_ctx: Any, new_message: Any) -> None:
            if speaker_sidecar is not None:
                # 旁路声纹:只调度不等待(create_task ~µs,不拖承接音/回复)
                asyncio.create_task(speaker_sidecar.on_turn())
            if bank is None:
                return
            try:
                # 打断轮 filler 必播(B 2026-07-18):打断=用户最主动的动作,响应感要求最高;
                # 概率掷丢会让"打断→静默 1.5s→才有声"的体感放大成"没反应"(21:24 轮实证)。
                # 5s 窗口=打断到本 turn 提交的最大合理间隔(实测 0.5-2s)。
                boost = (
                    interrupt_state is not None
                    and time.monotonic() - interrupt_state["ts"] < 5.0
                )
                clip = bank.pick(str(new_message.text_content or ""), boost=boost)
                if clip is not None:
                    self.session.say(
                        clip.text,
                        audio=FillerBank.frame_iter(clip),
                        add_to_chat_ctx=False,
                    )
            except Exception:  # 承接音失败绝不拖垮回复主链路
                import logging

                logging.getLogger("voice_agent.fillers").exception("filler say 失败(忽略)")

    return _FillerAgent(instructions=instructions, tools=tools or None)


def _register_livekit_handlers(session: Any, bridge: LiveKitEventBridge) -> None:
    on = cast(Any, session.on)

    def _on_user_state_changed(event: object) -> None:
        bridge.user_state_changed(event)

    def _on_user_input_transcribed(event: object) -> None:
        bridge.user_input_transcribed(event)

    def _on_conversation_item_added(event: object) -> None:
        bridge.conversation_item_added(event)

    def _on_agent_state_changed(event: object) -> None:
        bridge.agent_state_changed(event)

    def _on_overlapping_speech(event: object) -> None:
        bridge.overlapping_speech(event)

    def _on_agent_false_interruption(event: object) -> None:
        bridge.agent_false_interruption(event)

    on("user_state_changed", _on_user_state_changed)
    on("user_input_transcribed", _on_user_input_transcribed)
    on("conversation_item_added", _on_conversation_item_added)
    on("agent_state_changed", _on_agent_state_changed)
    on("overlapping_speech", _on_overlapping_speech)
    on("agent_false_interruption", _on_agent_false_interruption)


def _register_metrics(session: Any, ctx: Any, agents_mod: Any) -> None:
    """每轮链路延迟(EOU 判停 / LLM TTFT / TTS TTFB)publish 到 room → web 页延迟面板。"""
    import json

    metrics_mod = agents_mod.metrics

    def _on_metrics(ev: Any) -> None:
        m = ev.metrics
        d: dict[str, Any] | None = None
        if isinstance(m, metrics_mod.EOUMetrics):
            d = {
                "k": "eou",
                "eou_ms": round(m.end_of_utterance_delay * 1000),
                "stt_ms": round(m.transcription_delay * 1000),
            }
        elif isinstance(m, metrics_mod.LLMMetrics):
            d = {
                "k": "llm",
                "ttft_ms": round(m.ttft * 1000),
                "tps": round(m.tokens_per_second, 1),
            }
        elif isinstance(m, metrics_mod.TTSMetrics):
            d = {"k": "tts", "ttfb_ms": round(m.ttfb * 1000)}
        if d is None:
            return
        asyncio.create_task(
            ctx.room.local_participant.publish_data(json.dumps(d), reliable=True, topic="metrics")
        )

    session.on("metrics_collected", _on_metrics)


__all__ = ["TierACascadeEngine", "_register_livekit_handlers"]
