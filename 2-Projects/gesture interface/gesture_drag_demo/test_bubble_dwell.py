"""v3.4 气泡凝视驻留自检：进度累积锁定 / 飘走衰减不清零 / 长离开释放。

直接 python test_bubble_dwell.py 运行（或 pytest）。
"""
from dataclasses import dataclass

from attention_selector import AttentionSelector
from config import (
    BUBBLE_LOCK_FRAMES, BUBBLE_PROGRESS_DECAY, BUBBLE_RELEASE_FRAMES,
)


@dataclass
class FakeBubble:
    cx: float
    cy: float = 200.0
    title: str = "b"


W = 1280


def _bubble_at_gaze(gaze_x: float) -> FakeBubble:
    """构造一个中心恰好在 gaze_x 上的气泡"""
    return FakeBubble(cx=(gaze_x + 1.0) / 2.0 * W)


def test_dwell_accumulates_to_lock():
    """持续凝视 → 进度线性累积 → 满 BUBBLE_LOCK_FRAMES 帧锁定。"""
    sel = AttentionSelector(W)
    b = _bubble_at_gaze(0.3)
    for i in range(BUBBLE_LOCK_FRAMES + 2):
        sel.update_bubbles(gaze_x=0.3, confidence=0.9, bubbles=[b])
    assert sel._bubble_locked
    assert sel.bubble_lock_progress == 1.0


def test_progress_decays_not_resets():
    """视线短暂飘走：进度衰减而非清零，回来接着涨。"""
    sel = AttentionSelector(W)
    b = _bubble_at_gaze(0.3)
    half = BUBBLE_LOCK_FRAMES // 2
    for _ in range(half):
        sel.update_bubbles(gaze_x=0.3, confidence=0.9, bubbles=[b])
    p_half = sel.bubble_lock_progress
    assert 0.0 < p_half < 1.0 and not sel._bubble_locked

    # 飘走 3 帧（低置信模拟）——衰减但没归零
    for _ in range(3):
        sel.update_bubbles(gaze_x=0.3, confidence=0.05, bubbles=[b])
    p_after = sel.bubble_lock_progress
    expected = (half - 3 * BUBBLE_PROGRESS_DECAY) / BUBBLE_LOCK_FRAMES
    assert abs(p_after - max(0.0, expected)) < 1e-9
    assert p_after > 0.0, "短暂飘走不应打回原点"

    # 回来继续 → 最终仍能锁定
    for _ in range(BUBBLE_LOCK_FRAMES):
        sel.update_bubbles(gaze_x=0.3, confidence=0.9, bubbles=[b])
    assert sel._bubble_locked


def test_long_absence_releases():
    """长时间离开 → 候选释放（现有 RELEASE 语义不被衰减机制破坏）。"""
    sel = AttentionSelector(W)
    b = _bubble_at_gaze(0.3)
    for _ in range(BUBBLE_LOCK_FRAMES + 2):
        sel.update_bubbles(gaze_x=0.3, confidence=0.9, bubbles=[b])
    assert sel._bubble_locked
    for _ in range(BUBBLE_RELEASE_FRAMES + 1):
        sel.update_bubbles(gaze_x=0.3, confidence=0.05, bubbles=[b])
    assert not sel._bubble_locked
    assert sel._bubble_candidate is None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"[run] {name}")
            fn()
    print("ALL PASS")
