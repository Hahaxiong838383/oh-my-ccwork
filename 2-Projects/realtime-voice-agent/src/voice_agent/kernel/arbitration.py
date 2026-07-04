"""来源优先级仲裁(ARCHITECTURE.md §7)——**非 LLM confidence 仲裁**,避免幻觉自证。

同一 ``key`` 多来源冲突时:高 ``SourceTier`` 覆盖低;同级取 ``ts`` 新者。
LLM confidence 只用于"是否进真值"的置信度门(见 ``extraction``),
**不用于裁决谁覆盖谁**——否则模型幻觉会自我增强。
"""

from __future__ import annotations

from .model import MemoryFact


class SourceArbiter:
    def arbitrate(self, existing: MemoryFact | None, incoming: MemoryFact) -> MemoryFact:
        """返回该 ``key`` 应保留的事实。"""
        if existing is None:
            return incoming
        if incoming.provenance.source > existing.provenance.source:
            return incoming
        if incoming.provenance.source < existing.provenance.source:
            return existing
        # 同来源优先级 → 取更新的
        return incoming if incoming.provenance.ts >= existing.provenance.ts else existing
