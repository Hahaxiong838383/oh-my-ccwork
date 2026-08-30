"""probe_ab_gaze.py — A/B 探针：现有手工管线 vs ptgaze ETH-XGaze（路线B第一步）

独立脚本，不进 app 主链，阅后即焚。跑法：
    ./.venv/bin/python probe_ab_gaze.py

流程（约 45s，跟随屏幕提示注视圆点）：
    准备 3s → 盯左 10s → 盯右 10s → 盯上 10s → 盯下 10s → 自动出报告

指标（每管线独立、裸信号无平滑无校准，公平对比信号源质量）：
    SNR_h = |右段中值 - 左段中值| / 静视噪声std（水平可分辨性）
    SNR_v = |下段中值 - 上段中值| / 静视噪声std（垂直可分辨性——现痛点）
    另报：单帧耗时、无脸丢帧率
报告落盘：probe_ab_result.txt + probe_ab_samples.csv（本目录）
"""
import csv
import math
import time

import cv2
import numpy as np

# ── A 管线：现有手工管线（生产同款，uncal 裸输出）──
from gaze_estimator import GazeEstimator as OursEstimator

# ── B 管线：ptgaze ETH-XGaze resnet18 ──
import os
import pathlib
from omegaconf import OmegaConf
from ptgaze.gaze_estimator import GazeEstimator as PtGazeEstimator
from ptgaze.utils import download_ethxgaze_model, download_mediapipe_face_landmarker
from ptgaze.config_schema import AppConfig

CAM_W, CAM_H = 1280, 720
PHASE_SECS = 10.0       # 每阶段时长
DISCARD_SECS = 2.0      # 每阶段开头丢弃（视线迁移+稳定）
PREP_SECS = 3.0
# 四个参考点（窗口比例坐标）：左右测水平、上下测垂直
PHASES = [
    ("LEFT",  (0.25, 0.50)),
    ("RIGHT", (0.75, 0.50)),
    ("UP",    (0.50, 0.25)),
    ("DOWN",  (0.50, 0.75)),
]


def build_ptgaze() -> PtGazeEstimator:
    """按 ptgaze main.py 的组装方式构造 ETH-XGaze 估计器（dummy 相机参数）。

    须 merge 结构化 schema——yaml 不含带默认值的键（如
    face_detector.mediapipe_model_path），裸 load 会缺键。
    """
    import ptgaze
    import shutil
    pkg_root = pathlib.Path(ptgaze.__file__).parent.resolve()
    loaded = OmegaConf.load(pkg_root / "data/configs/eth-xgaze.yaml")
    config = OmegaConf.merge(OmegaConf.structured(AppConfig), loaded)
    config.PACKAGE_ROOT = pkg_root.as_posix()
    # face_landmarker 收进项目 models/（ptgaze 默认下到 ~/.ptgaze，
    # 违反 HOME 顶层白名单；下载后搬进来并清掉顶层目录）
    local_task = pathlib.Path(__file__).parent / "models/face_landmarker.task"
    if not local_task.exists():
        download_mediapipe_face_landmarker()
        local_task.parent.mkdir(exist_ok=True)
        legacy = pathlib.Path("~/.ptgaze/mediapipe/face_landmarker.task").expanduser()
        shutil.move(legacy, local_task)
        shutil.rmtree(pathlib.Path("~/.ptgaze").expanduser(), ignore_errors=True)
    config.face_detector.mediapipe_model_path = local_task.as_posix()
    config.gaze_estimator.checkpoint = download_ethxgaze_model().as_posix()
    config.gaze_estimator.use_dummy_camera_params = True
    config.gaze_estimator.dummy_camera_size = [CAM_W, CAM_H]
    return PtGazeEstimator(config)


def main():
    import sys
    selftest = "--selftest" in sys.argv  # 静态人脸图假流：验证采样/统计/报告全路径

    print("[probe] 初始化 A 管线（现有手工）...")
    ours = OursEstimator()
    print("[probe] 初始化 B 管线（ptgaze ETH-XGaze，首次运行会下载模型）...")
    ptg = build_ptgaze()

    test_img = None
    if selftest:
        p = sys.argv[sys.argv.index("--selftest") + 1]
        test_img = cv2.resize(cv2.imread(p), (CAM_W, CAM_H))
        cap = None
        print("[probe] SELFTEST 模式：静态图假流 + 时间快进")
    else:
        cap = cv2.VideoCapture(0)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAM_W)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAM_H)
        if not cap.isOpened():
            raise RuntimeError("摄像头打不开")

    win = "AB Gaze Probe"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win, CAM_W, CAM_H)

    # samples[phase] = list of dict(t, ax, ay, bp, by, a_ms, b_ms)
    samples = {name: [] for name, _ in PHASES}
    a_miss = b_miss = total_frames = 0

    t_start = time.monotonic()
    aborted = False

    def phase_at(t):
        """返回 (阶段名, 圆点比例坐标, 是否在丢弃窗, 剩余秒) 或 None=全部结束"""
        if t < PREP_SECS:
            return ("PREP", None, True, PREP_SECS - t)
        t2 = t - PREP_SECS
        idx = int(t2 // PHASE_SECS)
        if idx >= len(PHASES):
            return None
        name, pos = PHASES[idx]
        t_in = t2 - idx * PHASE_SECS
        return (name, pos, t_in < DISCARD_SECS, PHASE_SECS - t_in)

    frame_idx = 0
    while True:
        if selftest:
            frame = test_img.copy()
            now = frame_idx / 30.0  # 时间快进：帧计数模拟 30fps 时间轴
        else:
            ok, frame = cap.read()
            if not ok:
                break
            frame = cv2.flip(frame, 1)  # 与生产管线一致的镜像帧
            now = time.monotonic() - t_start
        frame_idx += 1
        h, w = frame.shape[:2]
        ph = phase_at(now)
        if ph is None:
            break
        name, pos, discarding, remain = ph
        total_frames += 1

        # ── A 管线 ──
        ta = time.perf_counter()
        ra = ours.update(frame)
        a_ms = (time.perf_counter() - ta) * 1000
        a_ok = ra.face_detected and ra.confidence > 0
        if not a_ok:
            a_miss += 1

        # ── B 管线 ──
        tb = time.perf_counter()
        faces = ptg.detect_faces(frame)
        bp = byaw = None
        if faces:
            ptg.estimate_gaze(frame, faces[0])
            gv = faces[0].gaze_vector
            if gv is not None:
                bp, byaw = np.rad2deg(faces[0].vector_to_angle(gv))
        b_ms = (time.perf_counter() - tb) * 1000
        if bp is None:
            b_miss += 1

        # 记样本（仅正式采集窗 + 双管线都有输出的帧才计，保证同帧可比）
        if name != "PREP" and not discarding and a_ok and bp is not None:
            samples[name].append(dict(
                t=now, ax=ra.uncal_gaze_x, ay=ra.uncal_gaze_y,
                bp=float(bp), by=float(byaw), a_ms=a_ms, b_ms=b_ms))

        # ── UI ──
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, h), (25, 25, 25), -1)
        cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)
        if name == "PREP":
            cv2.putText(frame, f"Get ready... {remain:.0f}",
                        (w // 2 - 160, h // 2), cv2.FONT_HERSHEY_SIMPLEX,
                        1.2, (0, 200, 255), 2)
        else:
            dx, dy = int(pos[0] * w), int(pos[1] * h)
            pulse = 0.5 + 0.5 * math.sin(time.monotonic() * 4)
            cv2.circle(frame, (dx, dy), 16 + int(pulse * 6), (0, 200, 255), -1)
            cv2.circle(frame, (dx, dy), 4, (255, 255, 255), -1)
            state = "hold on..." if discarding else "RECORDING"
            color = (150, 150, 150) if discarding else (80, 220, 80)
            cv2.putText(frame, f"Look {name}  {state}  {remain:.0f}s",
                        (30, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
        # 两管线实时读数（肉眼看抖动）
        if a_ok:
            cv2.putText(frame, f"A ours  x={ra.uncal_gaze_x:+.3f} y={ra.uncal_gaze_y:+.3f} {a_ms:.0f}ms",
                        (30, h - 60), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 220, 90), 2)
        if bp is not None:
            cv2.putText(frame, f"B ptgz  yaw={byaw:+.2f} pitch={bp:+.2f} {b_ms:.0f}ms",
                        (30, h - 30), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (90, 180, 255), 2)

        cv2.imshow(win, frame)
        if (cv2.waitKey(1) & 0xFF) == 27:
            aborted = True
            break

    if cap is not None:
        cap.release()
    ours.close()
    cv2.destroyAllWindows()

    if aborted:
        print("[probe] 用户中断，不出报告")
        return

    # ── 统计 ──
    def stats(key_x, key_y):
        """返回 {phase: (med_x, med_y, std_x, std_y, n)}"""
        out = {}
        for name, _ in PHASES:
            rows = samples[name]
            if len(rows) < 30:
                out[name] = None
                continue
            xs = np.array([r[key_x] for r in rows])
            ys = np.array([r[key_y] for r in rows])
            out[name] = (float(np.median(xs)), float(np.median(ys)),
                         float(np.std(xs)), float(np.std(ys)), len(rows))
        return out

    def snr(st, axis):
        """axis='h' 用 LEFT/RIGHT 的 x 分量；'v' 用 UP/DOWN 的 y 分量"""
        a, b = ("LEFT", "RIGHT") if axis == "h" else ("UP", "DOWN")
        i = 0 if axis == "h" else 1
        if st[a] is None or st[b] is None:
            return None
        sig = abs(st[b][i] - st[a][i])
        noi = (st[a][2 + i] + st[b][2 + i]) / 2
        return sig / noi if noi > 1e-9 else float("inf")

    sa = stats("ax", "ay")
    sb = stats("bp", "by")  # 注意：bp=pitch(垂直), by=yaw(水平)
    # B 管线轴对应：水平=yaw(by 存 key 'by'), 垂直=pitch(key 'bp')
    sb_mapped = {}
    for name, _ in PHASES:
        v = sb[name]
        sb_mapped[name] = None if v is None else (v[1], v[0], v[3], v[2], v[4])
        # (med_yaw, med_pitch, std_yaw, std_pitch, n) → x=yaw, y=pitch

    all_rows = [r for name, _ in PHASES for r in samples[name]]
    a_mean_ms = np.mean([r["a_ms"] for r in all_rows]) if all_rows else 0
    b_mean_ms = np.mean([r["b_ms"] for r in all_rows]) if all_rows else 0

    lines = ["=" * 62,
             "A/B Gaze Probe 结果  (裸信号，无平滑无校准)",
             f"总帧 {total_frames}  A丢脸 {a_miss}  B丢脸 {b_miss}",
             f"单帧耗时  A={a_mean_ms:.1f}ms   B={b_mean_ms:.1f}ms",
             "-" * 62]
    for label, st in (("A 现有手工管线", sa), ("B ptgaze ETH-XGaze", sb_mapped)):
        sh, sv = snr(st, "h"), snr(st, "v")
        lines.append(f"{label}:")
        lines.append(f"  水平 SNR = {sh:.2f}" if sh is not None else "  水平 SNR = 样本不足")
        lines.append(f"  垂直 SNR = {sv:.2f}" if sv is not None else "  垂直 SNR = 样本不足")
        for name, _ in PHASES:
            v = st[name]
            lines.append(f"    {name:<6} " + ("样本不足" if v is None else
                         f"med=({v[0]:+.3f},{v[1]:+.3f}) std=({v[2]:.4f},{v[3]:.4f}) n={v[4]}"))
    # 结论
    ah, av = snr(sa, "h"), snr(sa, "v")
    bh, bv = snr(sb_mapped, "h"), snr(sb_mapped, "v")
    lines.append("-" * 62)
    if None in (ah, av, bh, bv):
        lines.append("结论: 样本不足，请重跑（每阶段需稳定注视）")
    else:
        ratio_h, ratio_v = bh / ah, bv / av
        lines.append(f"SNR 比 (B/A): 水平 {ratio_h:.2f}x  垂直 {ratio_v:.2f}x")
        if min(ratio_h, ratio_v) > 1.3:
            lines.append("结论: ptgaze 双轴显著更优 → 建议接入（第二步）")
        elif max(ratio_h, ratio_v) < 0.8:
            lines.append("结论: 现有管线更优 → 不换模型，走批次2调参")
        else:
            lines.append("结论: 互有胜负/相当 → 看垂直轴（现痛点）与耗时权衡，报告发 cc 定")
    lines.append("=" * 62)

    report = "\n".join(lines)
    print(report)
    # selftest 假数据绝不冒充真报告（文件名隔离）
    stem = "probe_selftest" if selftest else "probe_ab"
    with open(f"{stem}_result.txt", "w") as f:
        f.write(report + "\n")
    with open(f"{stem}_samples.csv", "w", newline="") as f:
        wcsv = csv.writer(f)
        wcsv.writerow(["phase", "t", "ax", "ay", "b_pitch", "b_yaw", "a_ms", "b_ms"])
        for name, _ in PHASES:
            for r in samples[name]:
                wcsv.writerow([name, f"{r['t']:.3f}", r["ax"], r["ay"],
                               r["bp"], r["by"], f"{r['a_ms']:.1f}", f"{r['b_ms']:.1f}"])
    print(f"[probe] 已写 {stem}_result.txt / {stem}_samples.csv")


if __name__ == "__main__":
    main()
