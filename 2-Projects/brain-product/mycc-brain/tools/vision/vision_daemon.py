#!/usr/bin/env python3
"""
vision_daemon.py — mycc-brain 视觉 sidecar（Phase 2B-1）

MobileNet-SSD 人体检测 + 帧差运动检测，输出 activity 状态文件。
brain 通过轮询 latest.json 获取视觉状态。

用法:
  python vision_daemon.py [--camera-index 0] [--data-dir ./data/activity]
"""

import argparse
import json
import os
import signal
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

# ── 常量 ──────────────────────────────────────
VERSION = "vision-daemon-v1"
MOTION_SIZE = (160, 120)
MOTION_THRESHOLD = 0.05  # motionLevel > 此值 → active，否则 idle
PERSON_CONFIDENCE_THRESHOLD = 0.5
MISS_COUNT_TO_AWAY = 3  # 连续 N 次未检到人 → present=false
PERSON_CLASS_ID = 15  # MobileNet-SSD class index for "person"


# ── 工具函数 ──────────────────────────────────
def now_iso():
    return datetime.now(timezone.utc).isoformat()


def today_date():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def atomic_write_json(path, data):
    """原子写入 JSON：先写 tmp 再 rename。"""
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=str(path.parent), suffix=".tmp", prefix=path.stem
    )
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_path, str(path))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def append_jsonl(path, data):
    """追加一行 JSON 到 JSONL 文件。"""
    with open(path, "a") as f:
        f.write(json.dumps(data, ensure_ascii=False) + "\n")


# ── 模型加载 ──────────────────────────────────
def find_models_dir():
    """模型目录：本脚本同级 models/。"""
    return Path(__file__).resolve().parent / "models"


def load_mobilenet_ssd(models_dir):
    """加载 MobileNet-SSD（cv2.dnn）。"""
    prototxt = models_dir / "MobileNetSSD_deploy.prototxt"
    caffemodel = models_dir / "MobileNetSSD_deploy.caffemodel"
    if not prototxt.exists():
        raise FileNotFoundError(f"Missing: {prototxt}")
    if not caffemodel.exists():
        raise FileNotFoundError(f"Missing: {caffemodel}")
    return cv2.dnn.readNetFromCaffe(str(prototxt), str(caffemodel))


# ── 检测函数 ──────────────────────────────────
def detect_person(net, frame):
    """MobileNet-SSD 人体检测。返回 (detected, confidence, count)。"""
    blob = cv2.dnn.blobFromImage(
        cv2.resize(frame, (300, 300)), 0.007843, (300, 300), 127.5
    )
    net.setInput(blob)
    detections = net.forward()

    max_conf = 0.0
    count = 0
    for i in range(detections.shape[2]):
        confidence = float(detections[0, 0, i, 2])
        class_id = int(detections[0, 0, i, 1])
        if class_id == PERSON_CLASS_ID and confidence > PERSON_CONFIDENCE_THRESHOLD:
            count += 1
            max_conf = max(max_conf, confidence)

    return count > 0, max_conf, count


def compute_motion_level(prev_gray, curr_gray):
    """帧差运动检测，返回 [0, 1] 归一化值。"""
    if prev_gray is None:
        return 0.0
    diff = cv2.absdiff(prev_gray, curr_gray)
    return float(np.mean(diff)) / 255.0


# ── CLI ───────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser(description="mycc-brain vision daemon")
    p.add_argument("--camera-index", type=int, default=0)
    p.add_argument("--data-dir", type=str, default=None,
                   help="输出目录，默认 mycc-brain/data/activity/")
    p.add_argument("--fps", type=float, default=1.0)
    p.add_argument("--detect-interval", type=int, default=5,
                   help="MobileNet-SSD 检测间隔（秒）")
    p.add_argument("--heartbeat-seconds", type=int, default=30,
                   help="JSONL 心跳间隔（秒）")
    p.add_argument("--once", action="store_true",
                   help="执行一次检测后退出")
    p.add_argument("--debug", action="store_true")
    return p.parse_args()


# ── 主循环 ────────────────────────────────────
def main():
    args = parse_args()

    # 确定输出目录
    if args.data_dir:
        data_dir = Path(args.data_dir)
    else:
        data_dir = Path(__file__).resolve().parent.parent.parent / "data" / "activity"
    data_dir.mkdir(parents=True, exist_ok=True)

    latest_path = data_dir / "latest.json"
    status_path = data_dir / "status.json"

    # 加载 MobileNet-SSD
    models_dir = find_models_dir()
    try:
        net = load_mobilenet_ssd(models_dir)
    except FileNotFoundError as e:
        print(f"[vision] ERROR: {e}")
        print("[vision] 请运行 setup_studio.sh 下载模型文件。")
        sys.exit(1)

    if args.debug:
        print(f"[vision] MobileNet-SSD loaded from {models_dir}")

    # 打开摄像头
    cap = cv2.VideoCapture(args.camera_index)
    if not cap.isOpened():
        print(f"[vision] ERROR: 无法打开摄像头 {args.camera_index}")
        sys.exit(1)

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    # 预热
    for _ in range(3):
        cap.read()

    print(f"[vision] 启动: camera={args.camera_index} fps={args.fps} "
          f"detect_interval={args.detect_interval}s")
    print(f"[vision] 输出: {data_dir}")

    # ── 状态变量 ──
    prev_motion_gray = None
    present = None        # None=unknown, True=在, False=不在
    miss_count = 0
    activity = "unknown"
    motion_level = 0.0
    last_confidence = 0.0

    started_at = now_iso()
    total_frames = 0
    dropped_frames = 0
    last_error = None
    last_detect_time = 0.0
    last_heartbeat_time = 0.0
    last_write_at = None
    prev_activity = None

    # 优雅退出
    running = True

    def handle_signal(_sig, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    interval = 1.0 / args.fps

    try:
        while running:
            loop_start = time.time()

            ret, frame = cap.read()
            if not ret:
                dropped_frames += 1
                last_error = f"Frame read failed at {now_iso()}"
                if args.debug:
                    print("[vision] 读帧失败")
                time.sleep(0.5)
                continue

            total_frames += 1

            # ── 1. 运动检测（160×120 灰度帧差）──
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            small_gray = cv2.resize(gray, MOTION_SIZE)
            small_gray = cv2.GaussianBlur(small_gray, (5, 5), 0)

            motion_level = compute_motion_level(prev_motion_gray, small_gray)
            prev_motion_gray = small_gray

            # ── 2. 人体检测（每 detect_interval 秒一次）──
            now = time.time()
            if now - last_detect_time >= args.detect_interval:
                last_detect_time = now
                try:
                    detected, conf, count = detect_person(net, frame)
                    last_confidence = conf

                    if detected:
                        miss_count = 0
                        if present is not True:
                            present = True
                            if args.debug:
                                print(f"[vision] 检测到人 conf={conf:.2f} count={count}")
                    else:
                        miss_count += 1
                        if miss_count >= MISS_COUNT_TO_AWAY and present is not False:
                            present = False
                            if args.debug:
                                print(f"[vision] 人离开 miss_count={miss_count}")
                except Exception as e:
                    last_error = f"Detection error: {e}"
                    if args.debug:
                        print(f"[vision] 检测异常: {e}")

            # ── 3. 推断 activity ──
            if present is True:
                activity = "active" if motion_level > MOTION_THRESHOLD else "idle"
            elif present is False:
                activity = "away"
            else:
                activity = "unknown"

            # ── 4. 写 latest.json（原子写入）──
            latest_data = {
                "schemaVersion": 1,
                "timestamp": now_iso(),
                "source": VERSION,
                "present": present,
                "presentConfidence": round(last_confidence, 3),
                "presentMethod": "mobilenet-ssd",
                "motionLevel": round(motion_level, 4),
                "motionMethod": "frame-diff",
                "activity": activity,
                "confidence": round(last_confidence, 3) if present is not None else 0.0,
            }

            try:
                atomic_write_json(latest_path, latest_data)
                last_write_at = now_iso()
            except Exception as e:
                last_error = f"Write latest.json failed: {e}"
                if args.debug:
                    print(f"[vision] 写入异常: {e}")

            # ── 5. 写 status.json（原子写入）──
            status_data = {
                "running": True,
                "startedAt": started_at,
                "lastFrameAt": now_iso(),
                "lastWriteAt": last_write_at,
                "lastError": last_error,
                "droppedFrames": dropped_frames,
                "totalFrames": total_frames,
                "version": VERSION,
            }

            try:
                atomic_write_json(status_path, status_data)
            except Exception as e:
                if args.debug:
                    print(f"[vision] 写 status.json 异常: {e}")

            # ── 6. 写日志 JSONL（状态变化 + 心跳）──
            state_changed = activity != prev_activity
            heartbeat_due = now - last_heartbeat_time >= args.heartbeat_seconds

            if state_changed or heartbeat_due:
                daily_path = data_dir / f"{today_date()}.jsonl"
                log_entry = {
                    "ts": now_iso(),
                    "activity": activity,
                    "present": present,
                    "motionLevel": round(motion_level, 4),
                    "confidence": round(last_confidence, 3),
                    "trigger": "change" if state_changed else "heartbeat",
                }
                try:
                    append_jsonl(daily_path, log_entry)
                    last_heartbeat_time = now
                except Exception as e:
                    if args.debug:
                        print(f"[vision] JSONL 写入异常: {e}")

            prev_activity = activity

            if args.debug and total_frames % 30 == 0:
                print(f"[vision] frame={total_frames} motion={motion_level:.4f} "
                      f"present={present} activity={activity}")

            # --once 模式
            if args.once:
                print(json.dumps(latest_data, indent=2))
                break

            # 精确节拍
            elapsed = time.time() - loop_start
            sleep_time = max(0, interval - elapsed)
            if sleep_time > 0:
                time.sleep(sleep_time)

    finally:
        cap.release()
        # 写最终 status
        final_status = {
            "running": False,
            "startedAt": started_at,
            "lastFrameAt": now_iso(),
            "lastWriteAt": last_write_at,
            "lastError": last_error,
            "droppedFrames": dropped_frames,
            "totalFrames": total_frames,
            "version": VERSION,
        }
        try:
            atomic_write_json(status_path, final_status)
        except Exception:
            pass
        print(f"[vision] 已停止。总帧数: {total_frames}")


if __name__ == "__main__":
    main()
