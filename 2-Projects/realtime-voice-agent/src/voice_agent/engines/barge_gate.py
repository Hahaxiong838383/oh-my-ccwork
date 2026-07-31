"""打断声纹门控(B9,2026-07-31):用声纹否决"不是主用户"的打断。

**要解决的场景**(0 字门的唯一失守处):客厅电视/旁人说话——ASR 出得了字,
所以字数门拦不住;人声持续不断,所以框架的假打断 timer 一直被重置、永远
不恢复。结果=AI 被电视打断后就此卡住。这是川哥"环境音让 AI 卡壳"的根因。

**为什么不能"先判声纹再决定打不打断"**:声纹要 ~1s 音频才可靠,而打断必须
在 ~100ms 内发生——两者物理上不可调和。所以形态是**乐观打断 + 事后否决**:
VAD 一响立即停(0 字门的瞬停体验一点不牺牲),并行攒音频跑声纹,判定非注册
用户就提前恢复播报。判定是主用户则什么都不做(正常打断流程继续)。

框架私有 API(``_activity._start_false_interruption_timer``)是恢复的唯一入口:
它内部处理了"是否已 pause / speech 是否还在 / 状态回滚 / audio_output.resume()"
全套语义,自己复刻必然漏项。用 getattr 防御 + 生效日志兜库升级。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger("voice_agent.barge_gate")


def should_resume(result: Any, min_speech_s: float) -> tuple[bool, str]:
    """判"这次打断该不该被否决"(纯函数,可单测)。

    返回 (是否恢复播报, 原因)。**默认不恢复**——误恢复=真人插话被无视,
    比偶尔被电视打断更伤;证据不足时一律放行打断。
    """
    if result is None:
        return False, "identify_failed"
    speech_s = float(getattr(result, "speech_s", 0.0) or 0.0)
    if speech_s < min_speech_s:
        # 音频太短,声纹结论不可信(短句 embedding 抖动大)
        return False, f"too_short({speech_s:.2f}s)"
    if getattr(result, "name", None) is not None:
        return False, f"registered({result.name})"
    return True, f"unregistered(best={getattr(result, 'best_score', 0.0):.3f})"


class BargeSpeakerGate:
    """打断后延迟取样 → 声纹判定 → 非注册用户则提前恢复播报。"""

    def __init__(
        self,
        sidecar: Any,
        session: Any,
        *,
        delay_s: float = 0.7,
        min_speech_s: float = 0.8,
        act: bool = False,
    ) -> None:
        self._sidecar = sidecar
        self._session = session
        self._delay_s = delay_s
        self._min_speech_s = min_speech_s
        # 🔴 act=False(默认)=**只观测不动作**:先收日志确认声纹在真实信道上判得准,
        # 再开真恢复。空跑一步不是谨慎过度——注册与识别若非同信道,score 会整体崩
        # (2026-07-03 真机实测 0.072),此时开动作=主用户的插话全部被否决,
        # 体验比不做还差。日志看 'barge gate' 行的 resume/score 分布再定。
        self._act = act
        self._task: asyncio.Task[None] | None = None

    def on_interrupt(self) -> None:
        """打断发生(agent speaking→listening)时调用,非阻塞。"""
        self.cancel()
        self._task = asyncio.create_task(self._judge())

    def cancel(self) -> None:
        """打断已被正常消化(用户说完/新回复开始)时调用,撤销待判定。"""
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None

    async def _judge(self) -> None:
        try:
            await asyncio.sleep(self._delay_s)  # 攒够音频再判
            pcm = self._sidecar.ring.peek()
            result = await asyncio.to_thread(
                self._sidecar._identifier.identify_sync, pcm
            )
            resume, reason = should_resume(result, self._min_speech_s)
            logger.info(
                "barge gate: resume=%s act=%s reason=%s scores=%s speech=%.2fs infer=%.0fms",
                resume, self._act, reason,
                getattr(result, "scores", {}),
                getattr(result, "speech_s", 0.0),
                getattr(result, "infer_ms", 0.0),
            )
            if resume and self._act:
                self._resume_now()
        except asyncio.CancelledError:
            raise
        except Exception:  # 门控永远不能拖垮主链路
            logger.exception("barge gate 判定失败(忽略,维持打断)")

    def _resume_now(self) -> None:
        """走框架自己的假打断恢复路径(timeout=0 即立即执行)。"""
        activity = getattr(self._session, "_activity", None)
        starter = getattr(activity, "_start_false_interruption_timer", None)
        if starter is None:
            logger.warning("barge gate: 框架恢复入口不存在(livekit-agents 升级?),本次放弃")
            return
        starter(0)


__all__ = ["BargeSpeakerGate", "should_resume"]
