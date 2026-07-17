"""承接句选桶单测(v5 收窄,2026-07-16)。

核心回归:裸单字 hint("讲/唱/背/念"、裸"给我")在闲聊里误伤 task 桶
(川哥实测"你讲得对"类闲聊回"马上安排"执行腔)——v5 收成 动词+量词 组合。
"""

from __future__ import annotations

from voice_agent.engines.fillers import FillerBank, pick_bucket


class TestPickBucketTaskNarrowing:
    """task 桶触发词收窄:请求句仍命中,闲聊句不再误伤。"""

    def test_real_requests_still_hit_task(self) -> None:
        assert pick_bucket("给我讲个故事好不好") == "task"
        assert pick_bucket("帮我查一下天气") == "task"
        assert pick_bucket("讲个笑话吧") == "task"
        assert pick_bucket("唱首歌听听") == "task"
        assert pick_bucket("推荐一部电影") == "task"

    def test_chitchat_no_longer_misfires_task(self) -> None:
        # v4 裸"讲"误伤
        assert pick_bucket("你讲得对，我也这么想") != "task"
        # v4 裸"唱"误伤
        assert pick_bucket("你唱歌真好听") != "task"
        # v4 裸"给我"误伤
        assert pick_bucket("这件事给我的感觉不太一样") != "task"
        # v4 裸"念"误伤
        assert pick_bucket("我有点想念家里了") != "task"

    def test_priority_unchanged(self) -> None:
        # 情绪优先于 task(共情优先原则)
        assert pick_bucket("好累啊，帮我放首歌") == "emo_neg"
        # 强叙述开场优先于 task("跟你说个事"的"说个"不被 task 抢)
        assert pick_bucket("跟你说个事儿") == "story"


class TestBucketProb:
    """桶级概率门(v5.2):只留 greet/thanks 低频覆盖(结构性堆叠),其余桶跟全局 0.9。"""

    def test_bucket_prob_values(self) -> None:
        prob = FillerBank._BUCKET_PROB
        assert prob["greet"] == 0.5
        assert prob["thanks"] == 0.5
        # emo 桶不再覆盖(全局 0.9 已高于旧覆盖 0.85,留着反而压低)
        assert "emo_neg" not in prob
        assert "emo_pos" not in prob


class TestBucketOverrideSemantics:
    """v5.1 修复回归:桶级概率是覆盖语义(非 min)——全局压 0 时 emo 桶仍按 0.85 独立生效。"""

    def test_bucket_override_beats_global(self, monkeypatch) -> None:
        import random as _random

        from voice_agent.engines.fillers import FillerClip

        clip_greet = FillerClip(text="嗨。", frames=[])
        clip_gen = FillerClip(text="嗯。", frames=[])
        bank = FillerBank({"greet": [clip_greet], "gen": [clip_gen]}, probability=0.0)
        monkeypatch.setattr(_random, "random", lambda: 0.3)
        # greet 覆盖 0.5 > 0.3 → 播;v5 的 min(0.0, 0.5)=0 会导致这里 None(bug 复现即失败)
        assert bank.pick("你好") is not None
        # gen 无桶级覆盖 → 用全局 0.0 → 不播
        assert bank.pick("随便聊聊天气") is None
