"""v3.8 ptgaze 后端自检：归一化映射 / 丢脸回退 legacy / 后端闸门。

不加载真模型（构造走 __new__ + mock），真模型全链由冒烟与真机验收覆盖。
直接 python test_ptgaze_backend.py 运行（或 pytest）。
"""
import pathlib

import cv2
import numpy as np

from config import GAZE_PT_DEG_SCALE, FACE_CONF_THRESHOLD, FACE_TRACK_THRESHOLD
from gaze_estimator import GazeEstimator
from one_euro import OneEuroFilter

TEST_FACE = pathlib.Path(__file__).parent / "assets/test_face.jpg"


class FakeFace:
    def __init__(self, pitch_deg, yaw_deg):
        self._p = np.deg2rad(pitch_deg)
        self._y = np.deg2rad(yaw_deg)
        self.gaze_vector = np.array([0.0, 0.0, -1.0])  # 非 None 即可

    def vector_to_angle(self, _v):
        return np.array([self._p, self._y])


class FakePtgaze:
    """可编程的 ptgaze 替身：faces=None 模拟丢脸。"""

    def __init__(self, pitch_deg=0.0, yaw_deg=0.0, miss=False):
        self.pitch, self.yaw, self.miss = pitch_deg, yaw_deg, miss

    def detect_faces(self, _frame):
        return [] if self.miss else [FakeFace(self.pitch, self.yaw)]

    def estimate_gaze(self, _frame, _face):
        pass

    def close(self):
        pass


def _bare_estimator(ptgaze) -> GazeEstimator:
    """__new__ 构造（跳过真 ptgaze 加载），FaceMesh 真建（update 需要）。"""
    import mediapipe as mp
    est = GazeEstimator.__new__(GazeEstimator)
    est._mp_face_mesh = mp.solutions.face_mesh
    est._face_mesh = est._mp_face_mesh.FaceMesh(
        static_image_mode=False, max_num_faces=1, refine_landmarks=True,
        min_detection_confidence=FACE_CONF_THRESHOLD,
        min_tracking_confidence=FACE_TRACK_THRESHOLD)
    est._filter_x = OneEuroFilter()
    est._filter_y = OneEuroFilter()
    est._lost_count = 0
    est._calib_coef_x = None
    est._calib_coef_y = None
    est._calibrated = False
    est._backend = "ptgaze"
    est._ptgaze = ptgaze
    est.ptgaze_miss_count = 0
    return est


def _load_face_frame():
    img = cv2.imread(TEST_FACE.as_posix())
    assert img is not None, f"缺测试人脸图 {TEST_FACE}"
    return cv2.resize(img, (1280, 720))


def test_normalize_sign_and_scale():
    """探针实测符号约定：看右 yaw 负→x 正；看下 pitch 负→y 正。"""
    est = _bare_estimator(FakePtgaze(pitch_deg=-7.5, yaw_deg=-7.5))
    out = est._ptgaze_infer(np.zeros((10, 10, 3), np.uint8))
    assert out is not None
    x, y = out
    assert abs(x - 7.5 / GAZE_PT_DEG_SCALE) < 1e-9  # yaw 负 → x 正
    assert abs(y - 7.5 / GAZE_PT_DEG_SCALE) < 1e-9  # pitch 负 → y 正
    est._face_mesh.close()


def test_normalize_clamps_extremes():
    """极端角度（如俯视 -31°）clamp 到 ±1，不越界。"""
    est = _bare_estimator(FakePtgaze(pitch_deg=-31.0, yaw_deg=40.0))
    x, y = est._ptgaze_infer(np.zeros((10, 10, 3), np.uint8))
    assert y == 1.0      # -(-31)/15=2.07 → clamp 1
    assert x == -1.0     # -40/15=-2.67 → clamp -1
    est._face_mesh.close()


def test_ptgaze_takes_over_raw_gaze():
    """真人脸帧：ptgaze 输出接管 raw/uncal gaze，backend 标 ptgaze。"""
    est = _bare_estimator(FakePtgaze(pitch_deg=-6.0, yaw_deg=-3.0))
    r = est.update(_load_face_frame())
    assert r.face_detected and r.backend == "ptgaze"
    assert abs(r.uncal_gaze_x - 3.0 / GAZE_PT_DEG_SCALE) < 1e-9
    assert abs(r.uncal_gaze_y - 6.0 / GAZE_PT_DEG_SCALE) < 1e-9
    est._face_mesh.close()


def test_miss_falls_back_to_legacy():
    """模型侧丢脸：本帧回退 legacy 手工信号顶帧 + miss 计数。"""
    est = _bare_estimator(FakePtgaze(miss=True))
    r = est.update(_load_face_frame())
    assert r.face_detected and r.backend == "legacy"
    assert est.ptgaze_miss_count == 1
    # legacy 顶帧值来自手工融合（非 0 占位）
    assert (r.uncal_gaze_x, r.uncal_gaze_y) != (0.0, 0.0)
    est._face_mesh.close()


def test_backend_gate_off():
    """闸门：_ptgaze=None 时永远 legacy（config 回滚等价路径）。"""
    est = _bare_estimator(None)
    r = est.update(_load_face_frame())
    assert r.backend == "legacy"
    assert est.ptgaze_miss_count == 0
    est._face_mesh.close()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"[run] {name}")
            fn()
    print("ALL PASS")
