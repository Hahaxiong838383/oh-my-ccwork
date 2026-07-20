"""LnMem-fpga 采集守护 v0 —— 会议场景数据采集（D3 软件先行，阶段 1）。

用法（开会前手动启动，散会 Ctrl-C 停止——手动启停是隐私设计的一部分）:
  .venv/bin/python capture_daemon.py [--session-note "周会"]

采什么 / 不采什么（隐私铁律，README 有完整声明）:
  采: 川哥侧摄像头的脸部特征值(64维数字) / 说话与否布尔 / 键鼠活动率 / 前台app名
  不采: 音频内容、屏幕内容、对方任何信息;原始视频帧不落盘
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from datetime import datetime
from pathlib import Path

import contract
from context_sources import KbdMouseActivity, MicVAD, frontmost_bundle_id
from events import AppSwitchDetector, EventLog, LeaveSeatDetector, SpeechEdge
from health import HealthSentinel

DATA_ROOT = Path.home() / ".lnmem-fpga" / "data" / "sessions"
MODEL_PATH = Path(__file__).parent / "models" / "face_landmarker.task"
TARGET_FPS = 15


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-note", default="")
    ap.add_argument("--camera-index", type=int, default=0)
    args = ap.parse_args()

    if not MODEL_PATH.exists():
        print(f"缺模型文件 {MODEL_PATH}\n先跑: bash setup_model.sh", file=sys.stderr)
        return 2

    import cv2
    from feature_frontend import FeatureFrontend, now_mono_ms

    sid = datetime.now().strftime("%Y%m%d-%H%M%S")
    sdir = DATA_ROOT / sid
    sdir.mkdir(parents=True, exist_ok=True)

    mono0, epoch0 = now_mono_ms(), time.time()
    session_meta = {
        "session_id": sid, "date": datetime.now().strftime("%Y-%m-%d"),
        "camera": f"index{args.camera_index}", "machine": "air",
        "lighting": "unknown", "note": args.session_note,
        "mono_at_start_ms": mono0, "epoch_at_start": epoch0,
        "contract_version": contract.CONTRACT_VERSION,
        "context_schema_id": contract.CONTEXT_SCHEMA_ID,
        "dead_by_design": contract.DEAD_BY_DESIGN_V0,
    }
    (sdir / "session_meta.json").write_text(
        json.dumps(session_meta, ensure_ascii=False, indent=1), encoding="utf-8")

    cap = cv2.VideoCapture(args.camera_index)
    if not cap.isOpened():
        print("摄像头打不开（TCC 权限?从川哥常用 Terminal 启动并点允许）", file=sys.stderr)
        return 3
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    frontend = FeatureFrontend(str(MODEL_PATH))
    frames_f = open(sdir / "frames.jsonl", "a", buffering=1, encoding="utf-8")
    elog = EventLog(sdir / "events.jsonl")
    speech = SpeechEdge(elog)
    leave = LeaveSeatDetector(elog)
    appsw = AppSwitchDetector(elog)
    kbd = KbdMouseActivity()
    vad = MicVAD()
    vad_ok = vad.start()
    sentinel = HealthSentinel(sdir / "health.json", contract.FEAT_DIM,
                              contract.CONTEXT_DIM,
                              contract.DEAD_BY_DESIGN_V0["context_dims"])

    stop = {"flag": False}
    signal.signal(signal.SIGINT, lambda *_: stop.update(flag=True))
    signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))

    print(f"▶ 采集开始 session={sid}  数据目录={sdir}")
    print("  （散会后 Ctrl-C 结束；本进程只存特征数字，不存音视频内容）")

    n, last_slow, last_status = 0, 0.0, 0.0
    period = 1.0 / TARGET_FPS
    try:
        while not stop["flag"]:
            t_loop = time.monotonic()
            ok, bgr = cap.read()
            if not ok:
                time.sleep(0.1); continue
            ts = now_mono_ms()
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            face = frontend.extract(rgb, ts)

            if t_loop - last_slow >= 1.0:          # 1Hz 慢速源
                last_slow = t_loop
                kbd.sample()
                appsw.update(ts, frontmost_bundle_id())

            speaking, vad_alive, _ = vad.snapshot()
            speech.update(ts, speaking)
            leave.update(ts, face.present)

            ctx = contract.build_context(
                last_event_type=elog.last_event_type,
                dt_last_event_s=elog.dt_last_event_s(ts),
                self_speaking=speaking,
                kbd_mouse_activity=kbd.activity,
                meeting_elapsed_s=(ts - mono0) / 1000.0,
                hour_float=datetime.now().hour + datetime.now().minute / 60.0,
            )
            ctx_valid = bool(vad_ok and vad_alive and kbd.alive)

            rec = contract.FrameRecord(
                ts_mono_ms=ts, track_id=0, face_bbox=face.bbox, pose=face.pose,
                pose_valid=face.pose_valid, feat=face.feat, context=ctx,
                context_valid=ctx_valid, quality=face.quality, valid=face.present)
            frames_f.write(rec.to_json() + "\n")
            n += 1
            sentinel.update(face.feat, ctx)
            for w in sentinel.maybe_report():
                print(f"\n⚠️  哨兵告警: {w}")

            if t_loop - last_status >= 1.0:
                last_status = t_loop
                fps = 1.0 / max(1e-6, time.monotonic() - t_loop + period)
                print(f"\r帧{n} ~{min(fps, TARGET_FPS):.0f}fps 脸{'✓' if face.present else '✗'} "
                      f"说话{'✓' if speaking else '✗'} 键鼠{kbd.activity:.0%} "
                      f"事件{elog.count} ctx{'✓' if ctx_valid else '✗'}   ",
                      end="", flush=True)

            dt_sleep = period - (time.monotonic() - t_loop)
            if dt_sleep > 0:
                time.sleep(dt_sleep)
    finally:
        cap.release(); frontend.close(); vad.stop(); elog.close(); frames_f.close()
        session_meta["mono_at_end_ms"] = now_mono_ms()
        session_meta["frames"] = n
        (sdir / "session_meta.json").write_text(
            json.dumps(session_meta, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n■ 采集结束 共{n}帧 {elog.count}事件 → {sdir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
