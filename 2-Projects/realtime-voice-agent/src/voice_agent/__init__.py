"""通用型实时语音 Agent。

架构一句话:**体验引擎可插拔(变),记忆内核恒定(不变),两者之间是一份稳定契约。**

四层(详见 ARCHITECTURE.md):
- ``contract``  稳定契约(不变)        — 归一化事件模型,记忆内核只认它
- ``engines``   体验引擎层(可插拔/变) — Tier A Cascade(★MVP) / B 托管 Realtime / C 自托管双流
- ``adapters``  适配层(每 Tier 一个)  — 引擎事件 → 归一化契约
- ``kernel``    记忆内核(恒定/CQRS)   — DRAFT 状态机 + Event Log + 投影 + 仲裁

冷热路径编排见 ``pipeline``;评测见 ``eval``。
"""

__version__ = "0.0.1"
