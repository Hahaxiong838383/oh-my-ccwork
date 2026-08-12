"""火山豆包流式 ASR → LiveKit STT plugin(云 API 瘦客户端,非本地模型)。

方向(2026-06-26 源码深读纠偏 [[feedback_livekit_stt_tts_online_over_local_turn443]]):
LiveKit 设计哲学 = STT 接在线 provider(70 官方 plugin 本地实现=0);本地 sherpa 把一句话
切碎成多 turn 是"阻抗不匹配"。火山服务端**内置语义判停**(segment_duration_ms 静音窗自动
切句给 definite=true)→ 根治切碎,plugin 不用自己做 VAD/endpointing。

协议(2026-06-26 research Agent 两生产实现交叉验证):
- wss://openspeech.bytedance.com/api/v3/sauc/bigmodel(流式端点)
- 鉴权 HTTP 握手头 X-Api-App-Key(App ID)+X-Api-Access-Key(Access Token)+X-Api-Resource-Id
封装 ``doubao_speech._ws_client.asr_stream``(MIT,二进制帧/gzip/事件已实现):
吃 ``audio_source: AsyncIterator[bytes]``,yield ``{text, is_final, utterances}``。
凭据走 env 注入(VOLC_APP_ID / VOLC_ACCESS_TOKEN),不硬编码。

⚠️ FINAL 映射(2026-06-26 probe 实测 + grok review 修正):doubao 的 ``is_final`` 只在整流
结束(LastNoSeq)才 true,火山**逐句 definite=true 才是 turn-final**。必须按 utterances[].definite
逐句发 FINAL(per-句 text),否则 turn 永不提交→不触发 LLM/TTS。

★ S1 pipeline 重叠(投机重叠,藏 LLM 进判停):LiveKit preemptive 投机只认 PREFLIGHT_TRANSCRIPT/
FINAL_TRANSCRIPT 触发,且复用是 **PREFLIGHT 文本 == 最终 FINAL 文本字符串全等**
(agent_activity.py:2249),不等则 miss=丢弃投机+重跑 LLM+白烧 token(体验回退现状,无损)。
- S1 v1(2026-06-29,已弃):尾句 interim 末字 ∈ 句末标点才 emit。实测**零命中**——火山 interim 对中文
  短指令 definite 才补标点、interim 没补 → 启发式不触发。
- S1 v2(2026-06-29,已弃):canonical 去标点 + interim 稳定窗(连续 N 次全等且 M ms 不变)。
  死因=触发时钟挂在火山 interim 回调上:end_window=200 时尾句 interim 稳定期只 ~377ms/2 次回调,
  N=3/M=450 永远来不及——**判停压得越短,回调窗口越小,稳定窗结构性失效**。
- ★ S1 v3(2026-07-02,现行):**触发时钟改挂用户音频**——``_pump_input`` 逐帧算平均幅度,
  「连续静音 ≥ silence_ms」+「尾句 interim 文本静止 ≥ text_quiet_ms」双条件即 emit PREFLIGHT。
  时钟起点从"火山何时回调"变成"用户何时闭嘴",不再被 end_window 压缩:静音 ~180ms 触发,
  距 turn commit(静音 + min_endpointing_delay ≈ 550ms 起)仍有 ~370-650ms 投机窗,LLM TTFT
  (~750ms)大半藏进判停。命中率由 canonical 保底(v2 遗产):PREFLIGHT 与 FINAL 都过
  ``_canon_transcript``,内容不变则字符串全等必命中;miss(静音后又补字/尾字 rewrite)自动
  回退 FINAL 触发的正常投机,只白烧一次 token。
  门控 VOLC_PREFLIGHT_ENABLED:关=canonical+投机全回退(FINAL 发原始带标点文本,无 PREFLIGHT)。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import unicodedata
from collections.abc import AsyncIterator
from typing import Any, Never

import numpy as np
from livekit.agents.language import LanguageCode
from livekit.agents.stt import (
    STT,
    RecognizeStream,
    SpeechData,
    SpeechEvent,
    SpeechEventType,
    STTCapabilities,
)
from livekit.agents.types import (
    DEFAULT_API_CONNECT_OPTIONS,
    NOT_GIVEN,
    APIConnectOptions,
    NotGivenOr,
)

logger = logging.getLogger("voice_agent.volc_stt")

VOLC_ASR_SR = 16000
_AUDIO_Q_MAX = 64  # 有界队列:asr_stream 先退出时 pump 背压停,不无限泄漏(grok review)


def build_hotwords_corpus(hotwords: list[str]) -> dict:
    """热词 corpus 载荷(2026-08-12 矩阵实验定案,纯函数可单测):
    context 必须是 JSON **字符串**而非嵌套对象(直连实证);消费方 _volc_asr.asr_stream。"""
    import json

    return {
        "context": json.dumps({"hotwords": [{"word": w} for w in hotwords]}, ensure_ascii=False)
    }


def parse_hotwords_env(raw: str | None) -> list[str]:
    """VOLC_ASR_HOTWORDS 解析(与 Rust 侧同名同格式):逗号分隔,trim,滤空。"""
    if not raw:
        return []
    return [w.strip() for w in raw.split(",") if w.strip()]


def _canon_transcript(s: str) -> str:
    """S1 投机命中关键(2026-06-29 team codex):PREFLIGHT 和 FINAL 都过此函数 → 去标点/
    空白后字符串全等,绕开"火山 definite 补句末标点、interim 没补"的 miss。保留数字小数点。"""
    s = unicodedata.normalize("NFKC", s or "")
    out: list[str] = []
    n = len(s)
    for i, ch in enumerate(s):
        if ch.isspace():
            continue
        # 保留数字间小数点,避免 "3.5" → "35"
        if ch == "." and 0 < i < n - 1 and s[i - 1].isdigit() and s[i + 1].isdigit():
            out.append(ch)
            continue
        if unicodedata.category(ch).startswith("P"):  # 各类标点(，。！？!? 等)
            continue
        out.append(ch)
    return "".join(out)


def _mean_abs_amp(chunk: bytes) -> float:
    """PCM16 帧的平均绝对幅度(S1 v3 静音检测)。说话 ~1000+,底噪/静音 <~200。"""
    if len(chunk) < 2:
        return 0.0
    arr = np.frombuffer(chunk[: len(chunk) // 2 * 2], dtype=np.int16)
    # int16 → int32 再取 abs,避开 -32768 取绝对值溢出
    return float(np.abs(arr.astype(np.int32)).mean())


def _ic_definite_action(pending: str, definite: str) -> str:
    """B5 interim 提交后,真 definite 到达时的三分决策(纯函数,可单测):
    - swallow  : 与伪 final 全等(canonical)——正常吞,本句已提交过
    - emit_new : definite 是 pending 的**真前缀延长**(用户在伪 final 后续说,如
                 "帮我放"→"帮我放周杰伦的歌")——补发全文开新一轮,比丢内容好
    - swallow_mismatch: 其余(识别改字/重排)——吞掉+遥测;再 emit 会对同一句重复回答
    """
    if definite == pending:
        return "swallow"
    if definite.startswith(pending) and len(definite) > len(pending) + 2:
        return "emit_new"
    return "swallow_mismatch"


def _pf_should_fire(
    *,
    tail: str,
    silence_since_ms: float | None,
    last_change_ms: float,
    now_ms: float,
    silence_ms: float,
    text_quiet_ms: float,
) -> bool:
    """S1 v3 触发判定(纯函数,可单测)。四条件:
    ① 尾句非空 ② 连续静音 ≥ silence_ms ③ 文本静止 ≥ quiet_ms
    ④ **interim 最后一次更新发生在静音开始之后**(2026-07-02 HK 实测 miss 根因:火山
    interim 滞后,用户说完时 interim 还停在半句,"静止 400ms"是 stale 不是完整——
    静音后火山会再回调 1-2 次补齐尾字,只有落在静音期内的更新才可信为全量)。"""
    if not tail or silence_since_ms is None:
        return False
    return (
        (now_ms - silence_since_ms) >= silence_ms
        and (now_ms - last_change_ms) >= text_quiet_ms
        and last_change_ms >= silence_since_ms
    )


class VolcSTT(STT[Never]):
    """火山豆包流式 ASR(凭据 env 注入)。"""

    def __init__(
        self,
        *,
        app_id: str = "",
        access_token: str = "",
        api_key: str | None = None,
        resource_id: str = "volc.bigasr.sauc.duration",
        language: str = "zh-CN",
        end_window_size: int | None = None,
        preflight_enabled: bool = True,
        preflight_silence_ms: float = 180.0,
        preflight_text_quiet_ms: float = 150.0,
        preflight_silence_amp: float = 250.0,
        speaker_ring: object | None = None,
        enable_ddc: bool = True,
        interim_commit: bool = False,
        hotwords: list[str] | None = None,
    ) -> None:
        super().__init__(capabilities=STTCapabilities(streaming=True, interim_results=True))
        self._app_id = app_id
        self._access_token = access_token
        # 新版控制台单 key(X-Api-Key);设了则走新版鉴权(seedasr 2.0 必须),否则旧版 app_id+token
        self._api_key = api_key
        self._resource_id = resource_id
        self._language = language
        # 火山句末静音判停窗(ms):None=用火山默认 ≈2900ms(判停慢主因);设 ~800 把判停压到 ~0.8s。
        # 实测延迟≈该值线性;调小有切碎风险(句中停顿)。详见 _volc_asr / 记忆 eou_tuning。
        self._end_window_size = end_window_size
        # S1 v3 投机重叠:静音+文本静止触发 emit PREFLIGHT,提前跑 LLM 藏进判停。
        # 关=canonical+投机全回退(FINAL 发原始带标点文本,无 PREFLIGHT)。
        self._preflight_enabled = preflight_enabled
        self._pf_silence_ms = preflight_silence_ms
        self._pf_text_quiet_ms = preflight_text_quiet_ms
        self._pf_silence_amp = preflight_silence_amp
        # 声纹旁路 ring buffer(speaker_id.AudioRingBuffer;None=关):pump 侧顺手留存
        # 本轮用户音频,turn 提交后旁路比对。带幅度过滤,静音帧不占容量。
        self._speaker_ring = speaker_ring
        # 语义顺滑(2026-07-04 team 圆桌 grok+codex 共识定案):火山服务端删语气词/停顿词/
        # 重复词提升可读性,服务端默认 False,我们显式开(陪伴场景字幕干净+不回应咳嗽)。
        # 风险:纯语气词整轮(如单字"嗯")理论上可能被顺滑清空成空文本——_run() 里有对应
        # 告警日志兜底观测,VOLC_ASR_ENABLE_DDC=0 可临时关闭验证是否命中。
        self._enable_ddc = enable_ddc
        # B5 interim 提交(POC,2026-07-29):S1 触发时刻直接用 canonical interim 发
        # FINAL 提交 turn(不等火山 definite ~350-550ms)——判停地板从"definite 到达"
        # 打到"interim 静止"(~330ms)。真 definite 到达后按 _ic_definite_action 三分。
        self._interim_commit = interim_commit
        # 热词(2026-08-12):捞回火山话语检测丢弃的孤立短指令(停/好/对);语气词不配
        # =环境音免疫保留。空列表=不传 corpus(火山默认行为)。
        self._hotwords = hotwords or []

    async def _recognize_impl(
        self,
        buffer: object,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> SpeechEvent:
        raise NotImplementedError("火山 STT 仅流式,请用 stream()")

    def stream(
        self,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> VolcRecognizeStream:
        return VolcRecognizeStream(self, conn_options=conn_options)


class VolcRecognizeStream(RecognizeStream):
    """逐帧推音频给火山 asr_stream,按 utterances[].definite 逐句发 FINAL、尾句发 INTERIM。"""

    def __init__(self, stt_: VolcSTT, *, conn_options: APIConnectOptions) -> None:
        # sample_rate=16k:基类自动把 LiveKit 输入帧重采样到火山要的 16k
        super().__init__(stt=stt_, conn_options=conn_options, sample_rate=VOLC_ASR_SR)
        self._volc = stt_
        self._pf_silence_since_ms: float | None = None  # 连续静音起点(音频时钟,pump 侧维护)
        # B5:最近一次伪 final 的 canonical 文本(None=本句未伪提交)。不进 _reset_pf——
        # 生命周期到"对应 definite 到达被消化"为止,跨越 pf 状态重置。
        self._ic_pending: str | None = None
        self._reset_pf()

    def _reset_pf(self) -> None:
        """S1 per-句段投机状态重置(definite 提交后,下个句段重新允许投机)。
        静音起点也清零:要求下一句段重新积累静音,防 definite 间隙误触发。"""
        self._pf_last_text = ""
        self._pf_last_change_ms = 0.0
        self._pf_silence_since_ms = None
        self._preflight_sent = False

    def _canon(self, raw: str) -> str:
        """preflight 开 → canonical 去标点(保投机命中);关 → 原样 strip(回退原始带标点行为)。"""
        return _canon_transcript(raw) if self._volc._preflight_enabled else raw.strip()

    def _emit(self, text: str, *, final: bool = False, preflight: bool = False) -> None:
        text = text.strip()
        if not text:
            return
        if preflight:
            ev = SpeechEventType.PREFLIGHT_TRANSCRIPT
        elif final:
            ev = SpeechEventType.FINAL_TRANSCRIPT
            # 证据日志(2026-07-04 川哥"字幕吃首字"排查):FINAL 全文落日志,缺字时
            # 直接对照定层位——FINAL 完整=前端/下游问题;FINAL 缺=上行音频/火山识别。
            logger.info("stt final: %s", text)
        else:
            ev = SpeechEventType.INTERIM_TRANSCRIPT
        alt = SpeechData(language=LanguageCode(self._volc._language), text=text)
        self._event_ch.send_nowait(SpeechEvent(type=ev, alternatives=[alt]))

    def _pf_on_frame(self, chunk: bytes, now_ms: float) -> None:
        """S1 v3 触发器(pump 侧逐帧):静音累积 + 双条件判定 → emit PREFLIGHT。
        触发时钟挂在用户音频上(非火山回调),不被 end_window 压缩。asyncio 单线程,
        与 recv 侧共享 _pf_* 状态无竞争。"""
        if self._preflight_sent:
            return
        if _mean_abs_amp(chunk) >= self._volc._pf_silence_amp:
            self._pf_silence_since_ms = None  # 出声中,静音计时清零
            return
        if self._pf_silence_since_ms is None:
            self._pf_silence_since_ms = now_ms
            return
        if _pf_should_fire(
            tail=self._pf_last_text,
            silence_since_ms=self._pf_silence_since_ms,
            last_change_ms=self._pf_last_change_ms,
            now_ms=now_ms,
            silence_ms=self._volc._pf_silence_ms,
            text_quiet_ms=self._volc._pf_text_quiet_ms,
        ):
            self._emit(self._pf_last_text, preflight=True)
            self._preflight_sent = True
            logger.info(
                "S1v3 preflight emitted (silence=%.0fms quiet=%.0fms tail=%r)",
                now_ms - self._pf_silence_since_ms,
                now_ms - self._pf_last_change_ms,
                self._pf_last_text[-16:],
            )
            if self._volc._interim_commit:
                # B5:同一时刻同一 canonical 文本直接发 FINAL 提交 turn——与 PREFLIGHT
                # 同源,投机命中率理论满格;真 definite 稍后到达由 _run 三分消化。
                self._ic_pending = self._pf_last_text
                self._emit(self._pf_last_text, final=True)
                logger.info("poc interim-commit: %r", self._pf_last_text[:40])

    async def _run(self) -> None:
        from ._volc_asr import asr_stream  # vendored:补 end_window_size 判停参数

        audio_q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=_AUDIO_Q_MAX)
        pf_on = self._volc._preflight_enabled
        ring: Any = self._volc._speaker_ring  # 声纹旁路(None=关)

        async def _pump_input() -> None:
            # 读 LiveKit 帧(基类已重采样 16k)→ PCM16 字节,await put 背压;输入结束 → None 收尾
            try:
                async for data in self._input_ch:
                    if isinstance(data, RecognizeStream._FlushSentinel):
                        continue
                    chunk = bytes(data.data)
                    if pf_on:
                        self._pf_on_frame(chunk, time.monotonic() * 1000.0)
                    if ring is not None:
                        ring.append(chunk)
                    await audio_q.put(chunk)
            finally:
                with contextlib.suppress(asyncio.QueueFull):
                    audio_q.put_nowait(None)

        async def _audio_source() -> AsyncIterator[bytes]:
            while True:
                chunk = await audio_q.get()
                if chunk is None:
                    return
                yield chunk

        pump = asyncio.create_task(_pump_input(), name="volc_asr_pump")
        agen = asr_stream(
            _audio_source(),
            audio_format="pcm",
            codec="raw",
            sample_rate=VOLC_ASR_SR,
            bits=16,
            channel=1,
            app_id=self._volc._app_id,
            access_token=self._volc._access_token,
            api_key=self._volc._api_key,
            resource_id=self._volc._resource_id,
            end_window_size=self._volc._end_window_size,
            enable_ddc=self._volc._enable_ddc,
            hotwords=self._volc._hotwords,
        )
        final_n = 0  # 已 emit FINAL 的 definite 句数(utterances 累积前缀)
        try:
            async for res in agen:
                utts: list[dict[str, Any]] = res.get("utterances") or []
                now_ms = time.monotonic() * 1000.0
                # 逐句 FINAL:utterances 前缀里新出现的 definite 句(turn-final)。
                # canonical:FINAL 也去标点,与 PREFLIGHT 全等(否则 final 补标点→miss)。
                for i in range(final_n, len(utts)):
                    if utts[i].get("definite"):
                        canon_text = self._canon(str(utts[i].get("text") or ""))
                        if self._ic_pending is not None:
                            # B5:本句已伪 final 提交过,definite 按三分消化(绝不能
                            # 原样重发 FINAL——会对同一句开第二轮回答)
                            action = _ic_definite_action(self._ic_pending, canon_text)
                            if action == "swallow_mismatch":
                                logger.info(
                                    "poc interim-commit mismatch: pending=%r definite=%r",
                                    self._ic_pending[:40],
                                    canon_text[:40],
                                )
                            elif action == "emit_new":
                                # 伪 final 后用户续说:definite 全文当新 turn 补发
                                logger.info(
                                    "poc interim-commit continuation: %r", canon_text[:40]
                                )
                                self._emit(canon_text, final=True)
                            self._ic_pending = None
                            final_n = i + 1
                            self._reset_pf()
                            continue
                        if not canon_text.strip():
                            # 顺滑风险观测(2026-07-04 team 圆桌 grok+codex 共识):definite
                            # 句段文本为空——可能是纯语气词/停顿词被 enable_ddc 整段清空
                            # (用户说了话但这轮无声无息消失,_emit 会静默丢弃不留痕迹)。
                            # 此行是唯一证据:排查"AI 没反应"时先查这条,pre_interim_tail
                            # 非空则实锤是顺滑清空(说明用户确实说过、interim 曾捕捉到)。
                            logger.warning(
                                "stt: definite 句段顺滑后为空(疑似 enable_ddc 清空纯语气词),"
                                "raw_utterance=%r pre_interim_tail=%r",
                                utts[i],
                                self._pf_last_text,
                            )
                        self._emit(canon_text, final=True)
                        final_n = i + 1
                        self._reset_pf()  # definite 提交后,下个句段重新允许投机
                    else:
                        break
                # 尾句(进行中,非 definite)→ INTERIM;S1 v3 只记录文本与变化时刻,
                # 触发判定在 pump 侧 _pf_on_frame(音频时钟)。
                if utts and not utts[-1].get("definite"):
                    tail = self._canon(str(utts[-1].get("text") or ""))
                    self._emit(tail, final=False)
                    if pf_on and tail and tail != self._pf_last_text:
                        self._pf_last_text = tail
                        self._pf_last_change_ms = now_ms
                elif not utts:
                    self._emit(self._canon(str(res.get("text") or "")), final=False)
                # 整流结束(is_final/LastNoSeq):剩余尾句全部转 FINAL
                if res.get("is_final"):
                    for i in range(final_n, len(utts)):
                        tail_text = self._canon(str(utts[i].get("text") or ""))
                        if self._ic_pending is not None:
                            # B5:整流结束路径同样消化伪 final(仅首个剩余句可能对应)
                            if _ic_definite_action(self._ic_pending, tail_text) == "emit_new":
                                self._emit(tail_text, final=True)
                            self._ic_pending = None
                            continue
                        self._emit(tail_text, final=True)
                    final_n = len(utts)
        except Exception:
            logger.exception("火山 ASR 流异常(鉴权/连接/解码),本轮 STT 中止")
        finally:
            pump.cancel()
            with contextlib.suppress(Exception):
                await agen.aclose()
            with contextlib.suppress(BaseException):
                await pump


__all__ = ["VolcSTT", "VolcRecognizeStream"]
