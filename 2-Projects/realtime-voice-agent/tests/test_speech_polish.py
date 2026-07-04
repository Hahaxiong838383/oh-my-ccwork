"""C1 v2 语义承接音选桶 + TTS 舞台指示过滤 纯逻辑单测(2026-07-02 川哥反馈迭代)。

句首承接词剥除 2026-07-04 挪到 fast_llm.LeadingFillerStripper(流式,LLM 输出层),
测试同步迁移:同名断言经流式接口(feed 全文 + flush)等效覆盖,另补 chunk 边界用例。
"""

from __future__ import annotations

from voice_agent.engines.fast_llm import LeadingFillerStripper
from voice_agent.engines.fillers import pick_bucket
from voice_agent.engines.volc_tts import (
    has_speakable,
    strip_stage_directions,
)


def _strip_stream(*chunks: str) -> str:
    """按 chunk 序列喂 stripper,拼接全部输出(含 flush 残留)。"""
    s = LeadingFillerStripper()
    out = [s.feed(c) for c in chunks]
    out.append(s.flush())
    return "".join(out)


class TestPickBucket:
    def test_task_wins_over_ask(self) -> None:
        # 既含请求词("讲/给我")又含问尾("好不好"):回"没问题"比"让我想想"贴切
        assert pick_bucket("给我讲个恐龙故事好不好") == "task"

    def test_ask(self) -> None:
        assert pick_bucket("今天北京的天气怎么样啊") == "ask"
        assert pick_bucket("你是谁呢") == "ask"
        assert pick_bucket("恐龙为什么灭绝了") == "ask"

    def test_task(self) -> None:
        assert pick_bucket("帮我想个生日祝福") == "task"
        assert pick_bucket("推荐一部电影") == "task"

    def test_greet_short_only(self) -> None:
        # 问候限短句:长句里"你好"只是开场,主意图在后半句
        assert pick_bucket("你好呀") == "greet"
        assert pick_bucket("在吗") == "greet"
        assert pick_bucket("你好呀,帮我讲个睡前故事吧") == "task"

    def test_thanks_short_only(self) -> None:
        assert pick_bucket("谢谢你呀") == "thanks"
        assert pick_bucket("谢谢,那你再给我推荐一部电影呗") == "task"

    def test_emo_neg_over_task(self) -> None:
        # 共情优先(指南 §10):带强情绪时先接情绪,即使句里也有请求词
        assert pick_bucket("我今天好累啊") == "emo_neg"
        assert pick_bucket("我好难过,给我讲个笑话吧") == "emo_neg"

    def test_emo_pos(self) -> None:
        assert pick_bucket("我今天考试满分,太开心了!") == "emo_pos"

    def test_story_backchannel(self) -> None:
        assert pick_bucket("跟你说个事儿") == "story"
        assert pick_bucket("我今天在学校捡到一只小猫") == "story"

    def test_opinion_after_ask(self) -> None:
        assert pick_bucket("我觉得这个动画片特别好看") == "opinion"

    def test_gen_fallback(self) -> None:
        assert pick_bucket("随便聊聊") == "gen"
        assert pick_bucket("") == "gen"


class TestStripStageDirections:
    def test_strips_paren_directions(self) -> None:
        assert strip_stage_directions("（笑）好的呀，没问题。") == "好的呀，没问题。"
        assert strip_stage_directions("好的(叹气)，我知道了。") == "好的，我知道了。"
        assert strip_stage_directions("【停顿】然后呢") == "然后呢"
        assert strip_stage_directions("*笑*真有意思") == "真有意思"

    def test_keeps_long_paren_content(self) -> None:
        # 超过 12 字的括号内容视为真实信息,保留(只滤短舞台指示)
        text = "这件事（发生在很久很久以前的一个小村庄）很有名。"
        assert strip_stage_directions(text) == text

    def test_strips_emoji(self) -> None:
        assert strip_stage_directions("好呀😀明天见") == "好呀明天见"

    def test_all_filtered_falls_back(self) -> None:
        # 全滤成空 → 回退原文,防空 TTS 请求
        assert strip_stage_directions("（笑）") == "（笑）"

    def test_plain_text_unchanged(self) -> None:
        assert strip_stage_directions("今天天气不错。") == "今天天气不错。"


class TestLeadingFillerStripper:
    def test_strips_filler_openers(self) -> None:
        # 承接音已播,正文再以承接词开头=结巴(2026-07-03 川哥反馈)
        assert _strip_stream("嗯，天空是蓝色的。") == "天空是蓝色的。"
        assert _strip_stream("好的，我来给你讲。") == "我来给你讲。"
        assert _strip_stream("让我想想……其实是散射。") == "其实是散射。"
        assert _strip_stream("这个嘛，要看情况。") == "要看情况。"

    def test_strips_stacked_fillers(self) -> None:
        assert _strip_stream("嗯，好的，我们走。") == "我们走。"

    def test_keeps_normal_openers(self) -> None:
        # 单字/短语后无标点 = 正常语义开头,绝不剥
        assert _strip_stream("好的开始是成功的一半。") == "好的开始是成功的一半。"
        assert _strip_stream("好听的歌有很多。") == "好听的歌有很多。"
        assert _strip_stream("行动起来吧。") == "行动起来吧。"

    def test_all_filler_falls_back(self) -> None:
        # 整回复就是承接词 → 缓冲到 flush 原样吐出(不剥空)
        assert _strip_stream("好的。") == "好的。"

    def test_chunk_boundary_inside_filler(self) -> None:
        # 承接词与标点被 LLM chunk 边界切开,跨 chunk 仍正确剥
        assert _strip_stream("嗯", "，天空", "是蓝色的。") == "天空是蓝色的。"
        assert _strip_stream("好的", "，我来", "给你讲。") == "我来给你讲。"
        assert _strip_stream("让我", "想想…", "…其实是散射。") == "其实是散射。"

    def test_non_filler_first_char_zero_buffering(self) -> None:
        # 首字符不在承接词首字集 → 首 chunk 立即透传(开口延迟为零)
        s = LeadingFillerStripper()
        assert s.feed("今天") == "今天"
        assert s.feed("天气不错。") == "天气不错。"

    def test_filler_first_char_buffers_then_passes(self) -> None:
        # "我们"以词表首字开头但非承接词:短暂缓冲后凑满上限整体放行,内容无损
        assert _strip_stream("我们", "一起去公园", "散步吧。") == "我们一起去公园散步吧。"

    def test_stray_leading_filler_without_punct_kept(self) -> None:
        # "嗯嗯嗯对"无标点 → 不是承接词模式,保留
        assert _strip_stream("嗯嗯嗯对呀就是这样。") == "嗯嗯嗯对呀就是这样。"


class TestHasSpeakable:
    def test_lone_punctuation_not_speakable(self) -> None:
        # 2026-07-02 实锤:切句器把 LLM 输出的孤立右引号切成独立段,火山 0 帧报错
        assert not has_speakable("”")
        assert not has_speakable("。")
        assert not has_speakable("……")
        assert not has_speakable("  ")
        assert not has_speakable("")

    def test_normal_text_speakable(self) -> None:
        assert has_speakable("好的。")
        assert has_speakable("3.14")
        assert has_speakable("“你好”")
