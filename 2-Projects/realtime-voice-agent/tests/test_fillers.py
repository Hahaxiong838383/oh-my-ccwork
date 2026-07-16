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
    """桶级概率门:emo 桶逆势高于全局(共情优先),greet/thanks 最低(堆叠感最强)。"""

    def test_bucket_prob_values(self) -> None:
        prob = FillerBank._BUCKET_PROB
        assert prob["emo_neg"] == 0.85
        assert prob["emo_pos"] == 0.7
        assert prob["greet"] == 0.5
        assert prob["thanks"] == 0.5
