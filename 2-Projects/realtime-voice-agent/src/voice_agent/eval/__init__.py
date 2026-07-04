"""Voice-Eval — 离线回放 + 在线埋点(ARCHITECTURE.md §2 / PRODUCT-DEFINITION 附录 E)。

把全部 E0 断言推到 E4 的唯一载体;M0 的第一动作。
- ``metrics``:§5 指标定义 + 门槛(延迟 / EOU 误打断 / CER …)。
- ``replay``:Event Log 文字级审计 + 投影重建校验。
"""

from .metrics import (
    GateResult,
    cer,
    latency_gate,
    percentile,
    rate_gate,
)
from .replay import audit_trail, rebuild_working_set

__all__ = [
    "GateResult",
    "percentile",
    "cer",
    "latency_gate",
    "rate_gate",
    "audit_trail",
    "rebuild_working_set",
]
