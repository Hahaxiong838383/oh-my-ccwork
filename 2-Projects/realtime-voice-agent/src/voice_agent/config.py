"""运行配置 — 从环境变量(``.env``)读取,扁平不可变。

骨架阶段无需任何真值即可构造(全部有默认);真值在 M0 接线时填(见 ``.env.example``)。
secret 只从环境读,**绝不硬编码、绝不入库**。
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_CONFIDENCE_FLOOR = 0.6


@dataclass(frozen=True, slots=True)
class Settings:
    """全系统运行配置(只读快照)。"""

    voice_engine: str = "tier_a_cascade"
    # Tier A: RTC 传输(LiveKit)
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    # Tier A: 流式 STT / LLM / TTS
    stt_provider: str = ""
    stt_api_key: str = ""
    stt_model_dir: str = ""  # 本地 STT(sherpa)模型目录
    llm_provider: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    llm_base_url: str = ""  # OpenAI 兼容端点(如 Gemini proxy)
    tts_provider: str = ""
    tts_api_key: str = ""
    tts_voice: str = ""
    tts_model_dir: str = ""  # 本地 TTS(VoxCPM)模型目录
    # 首句必须短:LLM→TTS 按句流水,首句 token 累积 + TTS 合成决定"开口速度"
    # (2026-07-02 HK 实测首句累积 ~630ms 是大头);短首句能砍到 ~200-300ms。
    # 禁舞台指示:输出会被直接念出来,(笑)(叹气)类标记会被 TTS 读出(川哥实测反馈);
    # volc_tts.strip_stage_directions 兜底,这里 prompt 层先禁。
    agent_instructions: str = (
        "你是一个简洁、自然、可被打断的中文实时语音助手。"
        "回答的第一句话必须很短(10个字以内),直接进入内容。"
        "系统已经替你播放了口头承接音(比如'嗯,好问题''让我想想'),"
        "所以你的回答绝不要再用'好问题''让我想想''嗯''这个嘛'这类承接词或语气词开头,"
        "直接说答案本身,但保持口语的自然感。"
        "你的输出会被直接转成语音念出来:只写要念的口语文字,"
        "绝不要输出括号里的动作、表情或语气标注(比如(笑)(叹气)(停顿)),"
        "不用表情符号、不用列表和标题格式。"
        "系统可能通过声纹识别在消息末尾告诉你当前说话人是谁([声纹识别]开头的系统信息):"
        "把它当作你自然认得对方,直接用名字称呼;被问'我是谁/你知道我是谁吗'时自信答出;"
        "没有身份信息时如实说还没听出来。"
    )
    agent_greeting: str = "你好，我在。你可以直接打断我。"
    # Tier B: 托管 Realtime
    realtime_provider: str = ""
    realtime_api_key: str = ""
    # 记忆内核存储
    event_log_path: str = "./data/events"
    vector_index_path: str = "./data/vector.db"
    # 冷路径抽取置信度门
    extraction_confidence_floor: float = DEFAULT_CONFIDENCE_FLOOR

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """从环境变量装配(默认读 ``os.environ``;测试可注入 dict)。"""
        env: Mapping[str, str] = os.environ if environ is None else environ

        def get(key: str, default: str = "") -> str:
            return env.get(key, default)

        raw_floor = get("EXTRACTION_CONFIDENCE_FLOOR")
        floor = float(raw_floor) if raw_floor else DEFAULT_CONFIDENCE_FLOOR

        return cls(
            voice_engine=get("VOICE_ENGINE", "tier_a_cascade"),
            livekit_url=get("LIVEKIT_URL"),
            livekit_api_key=get("LIVEKIT_API_KEY"),
            livekit_api_secret=get("LIVEKIT_API_SECRET"),
            stt_provider=get("STT_PROVIDER"),
            stt_api_key=get("STT_API_KEY"),
            stt_model_dir=get("STT_MODEL_DIR"),
            llm_provider=get("LLM_PROVIDER"),
            llm_api_key=get("LLM_API_KEY"),
            llm_model=get("LLM_MODEL"),
            llm_base_url=get("LLM_BASE_URL"),
            tts_provider=get("TTS_PROVIDER"),
            tts_api_key=get("TTS_API_KEY"),
            tts_voice=get("TTS_VOICE"),
            tts_model_dir=get("TTS_MODEL_DIR"),
            agent_instructions=get(
                "AGENT_INSTRUCTIONS",
                "你是一个简洁、自然、可被打断的中文实时语音助手。",
            ),
            agent_greeting=get("AGENT_GREETING", "你好，我在。你可以直接打断我。"),
            realtime_provider=get("REALTIME_PROVIDER"),
            realtime_api_key=get("REALTIME_API_KEY"),
            event_log_path=get("EVENT_LOG_PATH", "./data/events"),
            vector_index_path=get("VECTOR_INDEX_PATH", "./data/vector.db"),
            extraction_confidence_floor=floor,
        )


__all__ = ["Settings", "DEFAULT_CONFIDENCE_FLOOR"]
