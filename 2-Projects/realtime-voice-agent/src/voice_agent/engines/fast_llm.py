# mypy: ignore-errors
"""Minimal LLM 客户端 —— 绕 livekit openai.LLM 厚 wrapper 降 TTFT。两种 api_style:

- **openai**(默认):openai ``AsyncOpenAI`` minimal 流式(DeepSeek 等 OpenAI 兼容)。诊断
  (2026-06-29 dev198 分层实测):同一 DeepSeek,curl ~170ms,openai SDK ~330ms,livekit
  openai.LLM ~600-1100ms。慢全在客户端栈。本类用 SDK minimal 调用绕 livekit wrapper。
- **ollama**(2026-06-29,gemma4 接 Studio 本地):走 ollama native ``/api/chat`` + ``think:false``。
  必须 native——实测 gemma4:e4b **有 thinking**,ollama /v1 OpenAI 兼容层**不透传 think**
  (/v1 裸调或带 think:false 都先吐 5.9s reasoning),只有 /api/chat think:false 能关(TTFT ~500ms)。
  httpx 流式 + 手动 NDJSON 分行(aiter_lines 对流式有缓冲延迟,用 aiter_bytes 自分行)。

只做对话补全流式(无 function tools,realtime-voice-agent 纯对话)。``LLM_FAST_CLIENT=0`` 回退官方。
详见记忆 [[project_realtime_voice_agent]] LLM 慢根因诊断 + gemma4 接入段。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Never

import httpx
import openai
from livekit.agents import APIConnectionError, APIConnectOptions, APIStatusError, llm
from livekit.agents.llm import (
    ChatChunk,
    ChatContext,
    ChoiceDelta,
    FunctionToolCall,
    Tool,
    ToolChoice,
)
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, NotGivenOr
from openai import AsyncOpenAI

logger = logging.getLogger("voice_agent.fast_llm")

# 进程级 AsyncOpenAI client 单例池(key=base_url+api_key)。
# 跨 job 复用 TLS 连接:每 job 新建 client 时首请求要建连(实测 HK ECS 2c2g ~1046ms),
# 复用已建连的 client ~550ms,省 ~450ms(2026-06-30 grok 提出+cc 验证,详见记忆)。
# livekit job process 是 prewarm fork 长存活,模块级单例在 process 内跨 job 复用。
_OPENAI_CLIENT_POOL: dict[tuple[str, str], AsyncOpenAI] = {}


def _pool_client(base_url: str, api_key: str) -> AsyncOpenAI:
    pool_key = (base_url, api_key)
    client = _OPENAI_CLIENT_POOL.get(pool_key)
    if client is None:
        client = AsyncOpenAI(base_url=base_url, api_key=api_key, max_retries=0)
        _OPENAI_CLIENT_POOL[pool_key] = client
    return client


@dataclass(frozen=True)
class _Endpoint:
    """赛马参赛路(R1,2026-07-03,范式移植自 MyJavis llm.ts 生产验证)。"""

    name: str
    model: str
    base_url: str
    api_key: str
    thinking: str  # "disabled"/"enabled"/"adaptive" 透传 extra_body;"off"=不传
    strip_think: bool  # MiniMax M 系把 <think> 混在 content 且 disabled 被静默忽略,须流式剥


_THINK_OPEN = "<think>"
_THINK_CLOSE = "</think>"


def _partial_suffix_len(s: str, tag: str) -> int:
    """s 的结尾与 tag 前缀的最大重叠长度(跨 chunk 标签边界检测)。"""
    max_k = min(len(s), len(tag) - 1)
    for k in range(max_k, 0, -1):
        if s.endswith(tag[:k]):
            return k
    return 0


class ThinkStripper:
    """流式剥 ``<think>...</think>``(可单测)。

    MiniMax M 系把思考混在 content 流出且 ``thinking:disabled`` 被静默忽略——不剥则
    TTS 把思考过程念出来([[feedback_voice_llm_speakable_ttft_selection]])。
    跨 chunk 安全:``<th|ink>`` / ``</th|ink>`` 被 chunk 边界切开也能正确识别
    (尾部与标签前缀重叠的部分缓存到下一次 feed)。
    """

    def __init__(self) -> None:
        self._in_think = False
        self._buf = ""

    def feed(self, chunk: str) -> str:
        self._buf += chunk
        out: list[str] = []
        while self._buf:
            if self._in_think:
                end = self._buf.find(_THINK_CLOSE)
                if end < 0:
                    # 未见闭合:整段丢弃,只留可能是 "</think>" 前缀的尾巴
                    keep = _partial_suffix_len(self._buf, _THINK_CLOSE)
                    self._buf = self._buf[len(self._buf) - keep :] if keep else ""
                    break
                self._buf = self._buf[end + len(_THINK_CLOSE) :]
                self._in_think = False
            else:
                start = self._buf.find(_THINK_OPEN)
                if start < 0:
                    keep = _partial_suffix_len(self._buf, _THINK_OPEN)
                    visible = self._buf[: len(self._buf) - keep] if keep else self._buf
                    self._buf = self._buf[len(self._buf) - keep :] if keep else ""
                    if visible:
                        out.append(visible)
                    break
                if start > 0:
                    out.append(self._buf[:start])
                self._buf = self._buf[start + len(_THINK_OPEN) :]
                self._in_think = True
        return "".join(out)

    def flush(self) -> str:
        """流结束:吐出残留可见文本(in-think 的残留=未闭合思考,丢弃)。"""
        tail = "" if self._in_think else self._buf
        self._buf = ""
        return tail


# 句首承接词(须后随标点才剥,防误伤"好的开始是成功一半");长词在前(alternation 按序)
_LEADING_FILLER_RE = re.compile(
    r"^(?:让我想一想|让我想想|我想想|这个嘛|好的|好嘞|好呀|好啊|嗯+|哦+|哈|唔|好|行)"
    r"\s*[,，。、…～~!！?？]+\s*"
)
_FILLER_FIRST_CHARS = frozenset("让我这好嗯哦哈唔行")
_FILLER_BUF_MAX = 8  # 最长词 5 字+标点即可判定;8 字兜底上限(~1-2 chunk)


class LeadingFillerStripper:
    """流式剥「回复开头」承接词(R2 v2,2026-07-04 川哥"TTS 第一个字没念出来"根因修复)。

    v1 在 volc_tts **句级**剥,副作用=只改送 TTS 的音频、字幕(LLM 原文)不变——
    川哥对照字幕听出"第一个字没念",以为 TTS 丢字。挪到 LLM 输出流后,
    TTS / 字幕 / 对话历史三者拿到同一份文本,天然一致。
    只剥流最开头(承接音叠加只发生在回复开头);第 2+ 句句首语气词是自然行文,保留。

    延迟设计:首字符不在词表首字集 → 直接放行(常见路径零缓冲);在集内最多缓冲
    8 字(与 StreamAdapter 切句 min_len=6 的攒句窗口重叠,额外开口延迟 ≈0-1 chunk)。
    整回复就是"好的。"→ 缓冲到 flush 原样吐出,结构上保证不剥空(剥的前提是
    match 末尾后还有字符,剥后必有剩余)。
    """

    def __init__(self) -> None:
        self._buf = ""
        self._passthrough = False
        self._strips = 0

    def feed(self, chunk: str) -> str:
        if self._passthrough:
            return chunk
        self._buf += chunk
        while self._strips < 3:  # 最多剥 3 层("嗯,好的,其实…")
            m = _LEADING_FILLER_RE.match(self._buf)
            if m is None:
                break
            if m.end() == len(self._buf):
                return ""  # 标点串可能未取满(贪婪 + 跨 chunk),继续缓冲
            self._buf = self._buf[m.end() :]
            self._strips += 1
        if not self._buf:
            return ""
        if (
            self._buf[0] not in _FILLER_FIRST_CHARS
            or len(self._buf) >= _FILLER_BUF_MAX
            or self._strips >= 3
        ):
            self._passthrough = True
            out, self._buf = self._buf, ""
            return out
        return ""

    def flush(self) -> str:
        """流结束:吐出未判定的缓冲(短回复整句是承接词时=原样保留,不剥空)。"""
        out, self._buf = self._buf, ""
        self._passthrough = True
        return out


class FastLLM(llm.LLM[Never]):
    """OpenAI 兼容 / ollama native 流式 LLM 瘦客户端(绕 livekit wrapper)。"""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        thinking: str = "disabled",
        api_style: str = "openai",
        num_ctx: int = 8192,
        fallback_model: str = "",
        fallback_base_url: str = "",
        fallback_api_key: str = "",
        fallback_thinking: str = "off",
        fallback_strip_think: bool = True,
        context_note_provider: Callable[[], str | None] | None = None,
        strip_leading_filler: bool = False,
    ) -> None:
        super().__init__()
        # 剥回复开头承接词(仅承接音启用时开,否则正文语气词是自然的该保留)
        self._strip_leading_filler = strip_leading_filler
        # 每次请求前调用,返回要注入 messages 近因位的动态上下文(如声纹身份);
        # None/异常=不注入。近因位(末尾 system)是 MyJavis 实测教训:身份段放前面
        # 会被 LLM 无视(mycc 34663dfaa contextNote 近因位修复)。
        self._note_provider = context_note_provider
        self._model = model
        self._base_url = base_url.rstrip("/")
        # ⚠️ ollama 默认 num_ctx=2048 会截断小可长 prompt(世界观+人设),必须显式调大
        # (记忆 ollama_default_num_ctx_2048_trap);仅 ollama 模式用。
        self._num_ctx = num_ctx
        # ⚠️ DeepSeek v4 默认带 reasoning(先思考再答),首 content 慢 ~2s,实时语音必须关:
        # thinking={"type":"disabled"} 关思考;enabled/adaptive 开;off=不传(兼容非 DeepSeek)。
        self._thinking = thinking
        self._api_style = api_style  # "openai"(DeepSeek 等) | "ollama"(本地 gemma4 /api/chat)
        # R1 赛马(2026-07-03,MyJavis 生产验证范式):主+兜底并发,首个可见 token 者胜。
        # 解 DeepSeek 官方 API 时段性过载(健康 660ms/晚高峰抖 1.3-40s)。三项配齐才开。
        self._ep_main = _Endpoint("main", model, self._base_url, api_key, thinking, False)
        self._ep_fallback: _Endpoint | None = None
        if fallback_model and fallback_base_url and fallback_api_key:
            self._ep_fallback = _Endpoint(
                "fallback",
                fallback_model,
                fallback_base_url.rstrip("/"),
                fallback_api_key,
                fallback_thinking,
                fallback_strip_think,
            )
        if api_style == "ollama":
            # 本地 ollama,长生成超时给足;connect 短(局域网)
            self._http = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0))
            self._client = None
        else:
            # max_retries=0:retry 交给 livekit LLMStream 基类,避免双重 retry。
            # 进程级单例复用 TLS 连接(省首请求建连 ~450ms,grok+cc 2026-06-30)。
            self._client = _pool_client(base_url, api_key)
            self._http = None

    def chat(
        self,
        *,
        chat_ctx: ChatContext,
        tools: list[Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN,
    ) -> FastLLMStream:
        return FastLLMStream(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options)

    async def aclose(self) -> None:
        # openai client 是进程级共享单例(_OPENAI_CLIENT_POOL),不在 job 结束时关,
        # 否则下个 job 复用到已关闭 client;随 process 退出自然释放。
        if self._http is not None:
            await self._http.aclose()


class FastLLMStream(llm.LLMStream):
    """openai SDK 或 ollama /api/chat 流式 → emit ChatChunk。"""

    def __init__(
        self,
        llm_: FastLLM,
        *,
        chat_ctx: ChatContext,
        tools: list[Tool],
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(llm_, chat_ctx=chat_ctx, tools=tools, conn_options=conn_options)
        self._fast = llm_
        # 回复开头承接词流式剥除(R2 v2):挂在统一 emit 口,三条路径生效
        self._filler = LeadingFillerStripper() if llm_._strip_leading_filler else None

    def _emit_content(self, cid: str, content: str) -> None:
        """统一出口:race/openai/ollama 三路径的 ChatChunk 都经此发出。"""
        if self._filler is not None:
            content = self._filler.feed(content)
        if not content:
            return
        self._event_ch.send_nowait(
            ChatChunk(id=cid, delta=ChoiceDelta(role="assistant", content=content))
        )

    def _emit_tool_calls(self, raw_tcs: list[Any]) -> None:
        """把 openai delta.tool_calls 片段合并后 emit FunctionToolCall 列表。"""
        from collections import defaultdict

        default = {"id": "", "name": "", "arguments": ""}
        by_idx: dict[int, dict[str, str]] = defaultdict(lambda: dict(default))
        for tc in raw_tcs:
            idx = getattr(tc, "index", 0) or 0
            if getattr(tc, "id", None):
                by_idx[idx]["id"] = tc.id
            fn = getattr(tc, "function", None)
            if fn:
                if getattr(fn, "name", None):
                    by_idx[idx]["name"] = fn.name
                if getattr(fn, "arguments", None):
                    by_idx[idx]["arguments"] += fn.arguments or ""
        livekit_tcs: list[FunctionToolCall] = []
        for info in by_idx.values():
            if info["name"]:
                livekit_tcs.append(
                    FunctionToolCall(
                        name=info["name"],
                        arguments=info["arguments"],
                        call_id=info["id"] or f"call_{len(livekit_tcs)}",
                    )
                )
        if livekit_tcs:
            self._event_ch.send_nowait(
                ChatChunk(id="tool", delta=ChoiceDelta(role="assistant", tool_calls=livekit_tcs))
            )

    async def _run(self) -> None:
        # 复用 livekit 消息转换(含 system/历史/dummy user 注入,避免空 user 报错)
        messages, _ = self._chat_ctx.to_provider_format("openai")
        # 动态上下文注入(P2 声纹身份等):追加为末尾 system=近因位,三条路径统一生效。
        # 每轮身份不变时投机(preflight)与正式请求注入内容一致,不破坏投机复用。
        if self._fast._note_provider is not None:
            try:
                note = self._fast._note_provider()
            except Exception:
                note = None
            if note:
                messages.append({"role": "system", "content": note})
                logger.info("llm ctx note 注入: %s…", note[:24])
        if self._fast._api_style == "ollama":
            await self._run_ollama(messages)
        elif self._fast._ep_fallback is not None and not self.tools:
            # 有 tools 时跳过 race（tool call 非 TTFT 敏感路径，简化实现）
            await self._run_race(messages)
        else:
            await self._run_openai(messages)
        # 流尾:吐出承接词判定缓冲的残留(整回复="好的。"类短句原样保留)
        if self._filler is not None:
            tail = self._filler.flush()
            if tail:
                self._event_ch.send_nowait(
                    ChatChunk(id="filler-flush", delta=ChoiceDelta(role="assistant", content=tail))
                )

    async def _run_race(self, messages: list[dict[str, Any]]) -> None:
        """R1 双路赛马(2026-07-03,范式=MyJavis llm.ts 生产验证):
        主(DeepSeek)+兜底(MiniMax)并发发起,**首个吐出可见 token(剥 think 后)的路
        claim 胜**,败者立即 cancel(省 token);单路失败另一路兜住,全败才抛错。
        - 裁决点必须是可见 token 而非首 chunk:think 混 content 的模型首 chunk 是
          "<think>",按 raw 裁决会让慢正文假胜([[speakable_ttft]])。
        - 比 fallback-on-timeout 优:最差延迟=min(两路真实 TTFT),不用猜 timeout。
        - barge-in:外层 cancel 本协程 → finally 级联 cancel 两路。
        - 空回复也 claim(极罕见),防整轮悬空。
        """
        eps = [self._fast._ep_main, self._fast._ep_fallback]
        state: dict[str, Any] = {"winner": None, "tasks": {}}
        t0 = time.perf_counter()

        async def _one(ep: _Endpoint) -> None:
            client = _pool_client(ep.base_url, ep.api_key)
            extra_body = (
                {"thinking": {"type": ep.thinking}}
                if ep.thinking in ("disabled", "enabled", "adaptive")
                else {}
            )
            stripper = ThinkStripper() if ep.strip_think else None
            # race 路径也尽量透传 tools（但外层在有 tools 时已优选单路）
            req_tools = None
            if self.tools:
                try:
                    from livekit.agents.llm import ToolContext
                    from livekit.agents.llm._provider_format import openai as ofmt

                    tc = ToolContext(self.tools)
                    req_tools = ofmt.to_fnc_ctx(tc)
                except Exception:
                    req_tools = None
            stream = await client.chat.completions.create(
                model=ep.model,
                messages=messages,
                stream=True,
                extra_body=extra_body,
                tools=req_tools,
            )
            try:
                async for chunk in stream:
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    content = delta.content if delta else None
                    if not content:
                        continue
                    visible = stripper.feed(content) if stripper else content
                    if not visible:
                        continue
                    if state["winner"] is None:
                        state["winner"] = ep.name  # claim(asyncio 单线程,天然原子)
                        logger.info(
                            "llm race won by %s ttft=%.0fms",
                            ep.name,
                            (time.perf_counter() - t0) * 1000,
                        )
                        for name, task in state["tasks"].items():
                            if name != ep.name:
                                task.cancel()
                    elif state["winner"] != ep.name:
                        return  # 已有别路胜出(防御,正常已被 cancel)
                    self._emit_content(f"race-{ep.name}", visible)
                # 流自然结束
                if state["winner"] is None:
                    state["winner"] = ep.name  # 空回复也 claim,防整轮悬空
                elif state["winner"] != ep.name:
                    return
                if stripper is not None:
                    tail = stripper.flush()
                    if tail:
                        self._emit_content(f"race-{ep.name}", tail)
            finally:
                with contextlib.suppress(Exception):
                    await stream.close()

        tasks = {ep.name: asyncio.create_task(_one(ep)) for ep in eps}
        state["tasks"] = tasks
        try:
            results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        finally:
            for task in tasks.values():  # barge-in/外层 cancel 时级联取消两路
                if not task.done():
                    task.cancel()
        if state["winner"] is None:
            errs = [r for r in results if isinstance(r, BaseException)]
            raise APIConnectionError(f"fast_llm race: 双路全败 {errs}")

    async def _run_openai(self, messages: list[dict[str, Any]]) -> None:
        # DeepSeek v4 关思考(extra_body 透传非标准参数);"off" 则不传(兼容非 DeepSeek)
        extra_body = (
            {"thinking": {"type": self._fast._thinking}}
            if self._fast._thinking in ("disabled", "enabled", "adaptive")
            else {}
        )
        # function calling 支持：把 LiveKit Tool 转成 openai 格式透传
        request_tools = None
        if self.tools:
            try:
                from livekit.agents.llm import ToolContext
                from livekit.agents.llm._provider_format import openai as ofmt

                tc = ToolContext(self.tools)
                request_tools = ofmt.to_fnc_ctx(tc)
            except Exception:
                request_tools = None
        try:
            stream = await self._fast._client.chat.completions.create(
                model=self._fast._model,
                messages=messages,
                stream=True,
                extra_body=extra_body,
                tools=request_tools,
            )
            # 收集 tool_calls（openai 流式分片到达，arguments 要拼接）
            collected_tcs: list[Any] = []
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta and getattr(delta, "tool_calls", None):
                    collected_tcs.extend(delta.tool_calls or [])
                    continue
                if delta and delta.content:
                    self._emit_content(chunk.id, delta.content)
            # 流结束后若有 tool_calls，合并后 emit 给 LiveKit 收集器
            if collected_tcs:
                self._emit_tool_calls(collected_tcs)
        except openai.APIStatusError as e:
            raise APIStatusError(
                str(e), status_code=e.status_code, request_id=e.request_id, body=e.body
            ) from e
        except openai.APIError as e:
            raise APIConnectionError(f"fast_llm: {e}") from e

    async def _run_ollama(self, messages: list[dict[str, Any]]) -> None:
        # ollama native /api/chat:think=False 关 gemma thinking(只有 native 能关,/v1 不透传)。
        # NDJSON 流(每行一个 JSON {message:{content,thinking},done});content 才 emit,thinking 丢弃。
        payload = {
            "model": self._fast._model,
            "messages": messages,
            "stream": True,
            "think": False,
            # keep_alive=-1:模型常驻不换出,避免冷启动 ~3s(暖后 ttft ~434ms)。Studio 常开内存够。
            "keep_alive": -1,
            "options": {"num_ctx": self._fast._num_ctx},
        }
        url = f"{self._fast._base_url}/api/chat"
        cid = "ollama-fastllm"
        try:
            async with self._fast._http.stream("POST", url, json=payload) as resp:
                resp.raise_for_status()
                buf = b""
                async for raw in resp.aiter_bytes():
                    buf += raw
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        obj = json.loads(line)
                        msg = obj.get("message") or {}
                        content = msg.get("content") or ""
                        if content:
                            self._emit_content(cid, content)
                        if obj.get("done"):
                            return
        except httpx.HTTPStatusError as e:
            raise APIStatusError(
                f"ollama {e.response.status_code}", status_code=e.response.status_code
            ) from e
        except httpx.HTTPError as e:
            raise APIConnectionError(f"fast_llm ollama: {e}") from e


async def prewarm_openai(base_url: str, api_key: str, model: str) -> None:
    """job 开头预热:发最小 dummy 请求建进程级单例 client 的 TLS 连接。

    livekit 每 job spawn 新子进程→新 client→首请求要建连(HK ECS 2c2g ~1.3s)。
    在 entrypoint 异步调用,利用「用户说首句 + 判停」的 ~2-3s 窗口提前建连,
    用户首句 LLM 请求时连接已建好→复用 ~550ms,省 ~450ms 建连(2026-06-30)。
    复用 _OPENAI_CLIENT_POOL(与首句 FastLLM 同一 client);静默失败不影响 job。
    R1 后赛马兜底路也应预热(app.py 对 LLM_FALLBACK_* 再调一次;thinking 参数对
    MiniMax 被静默忽略,无害)。
    """
    client = _pool_client(base_url, api_key)
    try:
        stream = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "hi"}],
            stream=True,
            max_tokens=8,
            extra_body={"thinking": {"type": "disabled"}},
        )
        async for _ in stream:
            break  # 首 chunk = 连接已建,够了
    except Exception:
        pass


__all__ = [
    "FastLLM",
    "FastLLMStream",
    "LeadingFillerStripper",
    "ThinkStripper",
    "prewarm_openai",
]
