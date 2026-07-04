"""Tier B/C 旁挂合成器(ARCHITECTURE.md §6/§9 失败模式对策)。

s2s 引擎 turn 边界糊时,旁挂一路 STT + LiveKit turn detector,**合成**
``UserTurnCommitted`` 喂记忆内核(E3:turn detector 可与 OpenAI Realtime 并用,另配 STT)。
唯有 turn detector 判定语义 EOU 时才合成 committed——否则只是中间结果。
"""

from __future__ import annotations

from ..contract.events import UserTurnCommitted
from ..contract.types import ItemId, TurnId


class SidecarTurnSynthesizer:
    """把旁挂 STT 的 final + turn detector 的 EOU 合成为唯一提交点。"""

    def synthesize(
        self,
        *,
        turn_id: str,
        item_id: str,
        text: str,
        ts: float,
        eou: bool,
    ) -> UserTurnCommitted | None:
        """``eou=True``(语义结束)才合成 ``UserTurnCommitted``;否则返回 ``None``。"""
        if not eou:
            return None
        return UserTurnCommitted(
            turn_id=TurnId(turn_id),
            item_id=ItemId(item_id),
            final_text=text,
            ts=ts,
        )


__all__ = ["SidecarTurnSynthesizer"]
