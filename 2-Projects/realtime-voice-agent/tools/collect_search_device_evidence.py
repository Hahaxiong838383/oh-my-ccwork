#!/usr/bin/env python3
"""Read-only P003 voice diagnostics; raw output stays in a private local directory.

Does not connect ADB transports, clear logcat, play audio, change settings, install
an APK, or wake a device. Select an already connected transport explicitly.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

PACKAGE = "com.futurus.p003.launcher"
SN_RE = re.compile(r"BJP003[0-9]{14}")


class CollectionError(Exception):
    pass


def private_write(path: Path, data: bytes) -> None:
    # Never follow/overwrite a pre-existing log or symlink.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


class Collector:
    def __init__(self, adb: str, serial: str, expected_sn: str, out: Path,
                 run_id: str, source_audio: Path | None = None):
        self.adb, self.serial, self.expected_sn = adb, serial, expected_sn
        self.out, self.run_id, self.source_audio = out, run_id, source_audio
        self.records: list[dict] = []

    def call(self, *args: str, required: bool = True) -> bytes:
        try:
            p = subprocess.run([self.adb, "-s", self.serial, *args],
                               capture_output=True, timeout=25, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise CollectionError("ADB command could not complete") from None
        if p.returncode and required:
            # Command/stderr may contain private diagnostics; keep them out of stdout.
            raise CollectionError("required ADB read failed")
        return p.stdout if p.returncode == 0 else b""

    def shell(self, *args: str, required: bool = True) -> bytes:
        return self.call("shell", shlex.join(args), required=required)

    def capture(self, name: str, command: tuple[str, ...]) -> None:
        before = time.time_ns() // 1_000_000
        data = self.shell(*command, required=False)
        after = time.time_ns() // 1_000_000
        private_write(self.out / name, data)
        self.records.append({"file": name, "host_start_ms": before,
                             "host_end_ms": after, "bytes": len(data),
                             "sha256": hashlib.sha256(data).hexdigest(),
                             "status": "captured" if data else "unavailable_or_empty"})

    def active_apk(self) -> dict:
        paths = self.shell("pm", "path", PACKAGE).decode().splitlines()
        bases = [x.removeprefix("package:") for x in paths if x.endswith("/base.apk")]
        if len(bases) != 1:
            raise CollectionError("cannot identify exactly one active base APK")
        sha = self.shell("sha256sum", bases[0]).decode().split()
        if not sha or not re.fullmatch(r"[a-fA-F0-9]{64}", sha[0]):
            raise CollectionError("active APK hash unavailable")
        version = self.shell("dumpsys", "package", PACKAGE).decode(errors="replace")
        code = re.search(r"\bversionCode=(\d+)\b", version)
        name = re.search(r"\bversionName=([^\r\n]+)", version)
        if not code or not name:
            raise CollectionError("active package version unavailable")
        return {"path": bases[0], "sha256": sha[0].lower(),
                "version_code": int(code[1]), "version_name": name[1].strip()}

    def run(self) -> dict:
        if not SN_RE.fullmatch(self.expected_sn):
            raise CollectionError("expected MCU SN has an invalid format")
        if self.call("get-state").strip() != b"device":
            raise CollectionError("selected ADB transport is not ready")
        # Cloud MCU identity is independent of ADB serial or a Mac account.
        actual = self.shell("settings", "get", "global", "p003_mcu_device_sn").decode().strip()
        if actual != self.expected_sn:
            raise CollectionError("MCU SN missing or different; stop without collecting other data")
        apk = self.active_apk()
        if self.source_audio is not None and not self.source_audio.is_file():
            raise CollectionError("source audio file unavailable")
        # A fresh directory prevents mixing evidence from different attempts.
        self.out.mkdir(mode=0o700, parents=False, exist_ok=False)
        manifest = {"schema": 1, "run_id": self.run_id,
                    "started_host_ms": time.time_ns() // 1_000_000,
                    "mcu_sn_sha256": hashlib.sha256(actual.encode()).hexdigest(),
                    "adb_transport_sha256": hashlib.sha256(self.serial.encode()).hexdigest(),
                    "apk": apk,
                    "read_only": True, "records": self.records,
                    "limits": ["no device pre/post-APM PCM callback installed",
                               "no SDK DNS/TCP/TLS EventListener installed",
                               "capture success is not a product test pass"]}
        if self.source_audio is not None:
            manifest["source_audio"] = {"sha256": hashlib.sha256(self.source_audio.read_bytes()).hexdigest(),
                                        "bytes": self.source_audio.stat().st_size}
        commands = [
            ("device-clock-private.txt", ("date", "+%s")),
            ("device-uptime-private.txt", ("cat", "/proc/uptime")),
            ("logcat-private.txt", ("logcat", "-d", "-v", "epoch")),
            ("audio-flinger-private.txt", ("dumpsys", "media.audio_flinger")),
            ("audio-policy-private.txt", ("dumpsys", "media.audio_policy")),
            ("audio-service-private.txt", ("dumpsys", "audio")),
            ("launcher-services-private.txt", ("dumpsys", "activity", "services", PACKAGE)),
            ("connectivity-private.txt", ("dumpsys", "connectivity")),
            ("dns-resolver-private.txt", ("dumpsys", "dnsresolver")),
        ]
        try:
            for filename, command in commands:
                self.capture(filename, command)
            actual_after = self.shell("settings", "get", "global", "p003_mcu_device_sn").decode().strip()
            manifest["apk_after"] = self.active_apk()
            if actual_after != actual or manifest["apk_after"] != apk:
                raise CollectionError("device identity or active APK changed during capture; evidence is not stable")
            manifest["status"] = "collected"
        except (CollectionError, OSError):
            manifest["status"] = "partial_capture_failed"
            raise
        finally:
            manifest["finished_host_ms"] = time.time_ns() // 1_000_000
            private_write(self.out / "manifest-private.json",
                          json.dumps(manifest, ensure_ascii=False, indent=2).encode())
        return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--adb", required=True)
    ap.add_argument("--serial", required=True, help="existing ADB transport, not MCU SN")
    ap.add_argument("--expected-sn", required=True)
    ap.add_argument("--run-id", required=True, help="same run ID as playback and recording")
    ap.add_argument("--out", type=Path, required=True, help="new private directory; parent must exist")
    ap.add_argument("--source-audio", type=Path)
    args = ap.parse_args()
    try:
        r = Collector(args.adb, args.serial, args.expected_sn, args.out,
                      args.run_id, args.source_audio).run()
    except (CollectionError, OSError) as e:
        # Do not echo subprocess output, environment, device text or credentials.
        print(str(e) if isinstance(e, CollectionError) else "local evidence write failed", file=sys.stderr)
        return 2
    print(json.dumps({"status": r["status"], "run_id": r["run_id"],
                      "files": len(r["records"]) + 1, "apk": r["apk"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
