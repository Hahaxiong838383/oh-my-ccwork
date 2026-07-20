"""context 采集源（隐私铁律：只采川哥侧元数据，绝不采内容）。

- 键鼠：ioreg HIDIdleTime（零权限、零内容，只有"多久没动"）→ 30s 窗活动率
- VAD：麦克风 RMS → 布尔 self_speaking；音频块算完即弃，绝不落盘
- 前台 app：仅 bundle id（元数据），进事件流不进 context 向量
"""
from __future__ import annotations

import re
import subprocess
import threading
import time
from collections import deque

_IDLE_RE = re.compile(rb'"HIDIdleTime"\s*=\s*(\d+)')


def hid_idle_seconds() -> float | None:
    """系统级键鼠空闲秒数；失败返回 None（链路断 → context_valid=false）。"""
    try:
        out = subprocess.run(
            ["ioreg", "-c", "IOHIDSystem", "-d", "4"],
            capture_output=True, timeout=2,
        ).stdout
        m = _IDLE_RE.search(out)
        return int(m.group(1)) / 1e9 if m else None
    except Exception:
        return None


class KbdMouseActivity:
    """每秒采样 idle，30 样本滑窗 → 活动率 [0,1]。"""

    def __init__(self, window: int = 30):
        self.samples: deque[int] = deque(maxlen=window)
        self.alive = False

    def sample(self) -> None:
        idle = hid_idle_seconds()
        if idle is None:
            self.alive = False
            return
        self.alive = True
        self.samples.append(1 if idle < 1.0 else 0)

    @property
    def activity(self) -> float:
        return sum(self.samples) / max(1, len(self.samples))


def frontmost_bundle_id() -> str:
    """前台 app bundle id（元数据）。拿不到返回 unknown，不硬失败。"""
    try:
        from AppKit import NSWorkspace  # pyobjc
        app = NSWorkspace.sharedWorkspace().frontmostApplication()
        return app.bundleIdentifier() or "unknown"
    except Exception:
        return "unknown"


class MicVAD:
    """麦克风能量 VAD：**自适应噪声地板** + 滞回 + 时长去抖 → self_speaking 布尔。

    2026-07-20 验收实锤教训：固定 close_db=-45 低于川哥房间底噪 → 门开永不关，
    80s session 只出 1 个 speech_start、0 个 speech_end。改为门限=地板+余量：
    - 地板跟踪：非说话态快降慢升；说话态以极慢速率跟随（防"永不关门"死锁，可自愈）
    - open = max(floor+15dB, -48)，close = max(floor+8dB, -55)
    隐私：callback 内算 RMS 后即弃音频块；无任何缓存/落盘路径。
    """

    CALIB_UPDATES = 15  # 冷启动校准 ~1.5s@10Hz：地板快速收敛、不判说话（采集是开会前手动启动的，此时没在说话是合理假设）

    def __init__(self, open_margin_db: float = 15.0, close_margin_db: float = 8.0,
                 open_ms: int = 300, close_ms: int = 800):
        self.open_margin, self.close_margin = open_margin_db, close_margin_db
        self.open_ms, self.close_ms = open_ms, close_ms
        self.noise_floor = -60.0
        self.speaking = False
        self.alive = False
        self.level_db = -120.0
        self._n_updates = 0
        self._edge_since: float | None = None
        self._lock = threading.Lock()
        self._stream = None

    def start(self) -> bool:
        try:
            import numpy as np
            import sounddevice as sd

            def cb(indata, frames, t, status):
                rms = float(np.sqrt(np.mean(np.square(indata[:, 0]))) + 1e-12)
                db = 20.0 * np.log10(rms)
                with self._lock:
                    self.level_db = db
                    self.alive = True
                    self._update(db)
                # indata 离开作用域即弃——不存音频

            self._stream = sd.InputStream(
                channels=1, samplerate=16000, blocksize=1600, callback=cb)
            self._stream.start()
            return True
        except Exception:
            self.alive = False
            return False

    def _update(self, db: float, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self._n_updates += 1
        if self._n_updates <= self.CALIB_UPDATES:
            self.noise_floor += 0.3 * (db - self.noise_floor)  # 冷启动快收敛
            return                                             # 校准期不判说话
        # 地板跟踪：非说话态 快降(0.2)/慢升(0.02)；说话态 0.01 跟随（防永不关门死锁，~1min 自愈）
        if not self.speaking:
            rate = 0.2 if db < self.noise_floor else 0.02
        else:
            rate = 0.01
        self.noise_floor += rate * (db - self.noise_floor)
        open_th = max(self.noise_floor + self.open_margin, -48.0)
        close_th = max(self.noise_floor + self.close_margin, -55.0)

        if not self.speaking:
            if db >= open_th:
                if self._edge_since is None:
                    self._edge_since = now
                elif (now - self._edge_since) * 1000 >= self.open_ms:
                    self.speaking = True
                    self._edge_since = None
            else:
                self._edge_since = None
        else:
            if db <= close_th:
                if self._edge_since is None:
                    self._edge_since = now
                elif (now - self._edge_since) * 1000 >= self.close_ms:
                    self.speaking = False
                    self._edge_since = None
            else:
                self._edge_since = None

    def snapshot(self) -> tuple[bool, bool, float, float]:
        with self._lock:
            return self.speaking, self.alive, self.level_db, self.noise_floor

    def stop(self):
        if self._stream is not None:
            try:
                self._stream.stop(); self._stream.close()
            except Exception:
                pass
