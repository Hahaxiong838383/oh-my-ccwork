"""语义分桶承接音(C1 v2,2026-07-02 川哥反馈迭代)。

v1(BackgroundAudioPlayer thinking_sound)两个问题:
①短语气音("嗯"~1s)太短,与 LLM 随后的长句回复衔接生硬;
②thinking 时随机播,语义与用户的问题无关。

v2 机制:``Agent.on_user_turn_completed``(此钩子拿得到用户 turn 完整文本,且执行在
回复 speech 排队**之前**,官方 docstring 明示可在此 say canned message)按问题类型
选桶 → ``session.say(text, audio=预缓存帧, add_to_chat_ctx=False)``:
- 与正式回复**同轨串行**排队:承接句播完自然接回复(v1 双轨叠加+淡出的生硬感消失);
- 承接句 1.5-2.5s,恰好盖住"LLM 首句 + TTS 首音"的 ~1.7-2s 窗口;
- 可被打断(barge-in 走统一 speech 中断);``add_to_chat_ctx=False`` 不污染对话历史。

资产:``scripts/gen_fillers.py`` 用线上同款火山音色生成
``assets/fillers/<bucket>_<n>.wav`` + ``manifest.json``(文件名→桶+文案)。
"""

from __future__ import annotations

import json
import logging
import random
import wave
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger("voice_agent.fillers")

_FRAME_MS = 100  # say(audio=) 喂帧粒度

# 桶判定线索(纯子串匹配,零延迟;2026-07-02 v3 按《人类日常对话句式全面指南》扩桶)。
# 设计原则:①共情优先(指南 §10/§六-6:用户带情绪时先接住情绪,再让 LLM 给内容)
# ②承接句只做语用功能不给实质立场(不抢 LLM 的答案)③greet/thanks 限短句
# (长句里"你好/谢谢"多半只是开场,主意图在后面)。
_GREET_HINTS = (
    "你好",
    "您好",
    "哈喽",
    "嗨",
    "早上好",
    "中午好",
    "下午好",
    "晚上好",
    "在吗",
    "在不在",
    "早啊",
    "早呀",
)
_THANKS_HINTS = ("谢谢", "感谢", "多谢", "辛苦", "谢啦", "谢了")
_EMO_NEG_HINTS = (
    "难过",
    "伤心",
    "想哭",
    "哭了",
    "委屈",
    "郁闷",
    "烦死",
    "好烦",
    "太烦",
    "气死",
    "生气",
    "好累",
    "累死",
    "太累",
    "害怕",
    "焦虑",
    "压力好大",
    "不开心",
    "心情不好",
    "无聊",
)
_EMO_POS_HINTS = ("开心", "高兴", "兴奋", "太棒", "太好了", "太好啦", "好爽", "哈哈")
_TASK_HINTS = (
    "讲",
    "说个",
    "说一",
    "给我",
    "帮我",
    "来个",
    "来一",
    "唱",
    "背",
    "念",
    "推荐",
    "介绍",
    "教我",
    "陪我",
    "翻译",
    "写个",
    "写一",
)
# 强叙述开场(几乎不可能是请求,优先于 task:"跟你说个事儿"的"说个"会被 task 误抢)
_STORY_STRONG_HINTS = ("跟你说", "告诉你", "你猜")
# 弱叙述开场(可能后接请求"我今天想听个故事",故排在 task 之后)
_STORY_HINTS = (
    "我今天",
    "我昨天",
    "我刚才",
    "我上次",
    "我们老师",
    "我们班",
    "我妈",
    "我爸",
    "我朋友",
)
_ASK_HINTS = (
    "怎么",
    "为什么",
    "什么",
    "哪",
    "几",
    "多少",
    "是不是",
    "吗",
    "呢",
    "好不好",
    "行不行",
    "对不对",
    "谁",
    "难道",
    "?",
    "？",
)
_OPINION_HINTS = ("我觉得", "我认为", "我感觉")


def pick_bucket(user_text: str) -> str:
    """按用户 turn 文本选承接音桶,优先级(高→低):
    greet(短句问候)> thanks(短句致谢)> emo_neg(共情优先)> emo_pos >
    task(请求,先于 ask:"给我讲个故事好不好"回"没问题"比"让我想想"贴)>
    story(叙述分享,backchannel)> ask(疑问)> opinion(观点)> gen(兜底)。"""
    t = (user_text or "").strip()
    if len(t) <= 10 and any(h in t for h in _GREET_HINTS):
        return "greet"
    if len(t) <= 10 and any(h in t for h in _THANKS_HINTS):
        return "thanks"
    if any(h in t for h in _EMO_NEG_HINTS):
        return "emo_neg"
    if any(h in t for h in _EMO_POS_HINTS):
        return "emo_pos"
    if any(h in t for h in _STORY_STRONG_HINTS):
        return "story"
    if any(h in t for h in _TASK_HINTS):
        return "task"
    if any(h in t for h in _STORY_HINTS):
        return "story"
    if any(h in t for h in _ASK_HINTS):
        return "ask"
    if any(h in t for h in _OPINION_HINTS):
        return "opinion"
    return "gen"


@dataclass
class FillerClip:
    text: str  # 字幕/日志用文案(与音频一致)
    frames: list[Any]  # 预解码 rtc.AudioFrame 列表(重放零合成延迟)


class FillerBank:
    """预缓存承接音库:load 一次(job 启动),pick 按语义选片,frame_iter 重放。"""

    def __init__(self, clips: dict[str, list[FillerClip]], probability: float) -> None:
        self._clips = clips
        self._probability = probability
        # v4(2026-07-16 川哥"重复多"反馈):防重复从"仅上一条"扩为最近 3 条滑窗——
        # 每桶 6-9 变体下排除近 3 条仍有 3-6 候选,近距离重复感大幅降。
        self._recent: deque[str] = deque(maxlen=3)

    @classmethod
    def load(cls, directory: Path, probability: float) -> FillerBank | None:
        """读 manifest.json + wav → AudioFrame。资产缺失/损坏返回 None(静默降级)。"""
        manifest_path = directory / "manifest.json"
        if not manifest_path.exists():
            return None
        try:
            from livekit import rtc

            manifest: dict[str, dict[str, str]] = json.loads(manifest_path.read_text())
            clips: dict[str, list[FillerClip]] = {}
            for fname, meta in manifest.items():
                wav_path = directory / fname
                if not wav_path.exists():
                    continue
                with wave.open(str(wav_path), "rb") as w:
                    sr = w.getframerate()
                    raw = w.readframes(w.getnframes())
                step = max(2, sr * 2 * _FRAME_MS // 1000)  # PCM16 mono 字节步长
                frames = [
                    rtc.AudioFrame(
                        data=raw[i : i + step],
                        sample_rate=sr,
                        num_channels=1,
                        samples_per_channel=len(raw[i : i + step]) // 2,
                    )
                    for i in range(0, len(raw) - len(raw) % 2, step)
                    if len(raw[i : i + step]) >= 2
                ]
                if frames:
                    clips.setdefault(str(meta.get("bucket", "gen")), []).append(
                        FillerClip(text=str(meta.get("text", "")), frames=frames)
                    )
            if not clips:
                return None
            total = sum(len(v) for v in clips.values())
            logger.info("filler bank loaded: %d clips buckets=%s", total, sorted(clips))
            return cls(clips, probability)
        except Exception:
            logger.exception("filler bank 加载失败(承接音降级关闭,不影响主链路)")
            return None

    # 桶级概率覆盖(R2,2026-07-03):greet/thanks 场景 LLM 本来就秒回短答,
    # 承接句+正文堆叠感强 → 降概率;其余桶用全局 FILLER_PROBABILITY。
    _BUCKET_PROB = {"greet": 0.6, "thanks": 0.6}

    def pick(self, user_text: str) -> FillerClip | None:
        """语义桶(空桶回退 gen)+ 桶级概率门控 + 避免连续重复同一句。"""
        bucket = pick_bucket(user_text)
        prob = min(self._probability, self._BUCKET_PROB.get(bucket, self._probability))
        if random.random() >= prob:
            return None
        pool = self._clips.get(bucket) or self._clips.get("gen") or []
        if not pool:
            return None
        cands = [c for c in pool if c.text not in self._recent] or pool
        clip = random.choice(cands)
        self._recent.append(clip.text)
        logger.info("filler picked bucket=%s text=%r", bucket, clip.text)
        return clip

    @staticmethod
    def frame_iter(clip: FillerClip) -> AsyncIterator[Any]:
        async def _gen() -> AsyncIterator[Any]:
            for f in clip.frames:
                yield f

        return _gen()


__all__ = ["FillerBank", "FillerClip", "pick_bucket"]
