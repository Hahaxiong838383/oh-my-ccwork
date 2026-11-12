#!/usr/bin/env python3
"""Finish one aliyun OAuth --no-browser login.

Writes nothing secret to stdout. The authorization URL is printed once as
AUTH_URL= because the operator must open it. The callback URL is read from
the path printed as CALLBACK_FILE= and is not echoed.
"""
import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ALIYUN = Path.home() / ".local/bin/aliyun"


def read_until(proc, pred, timeout_s):
    buf = bytearray()
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        chunk = proc.stdout.read(1)
        if not chunk:
            break
        buf += chunk
        if pred(buf):
            return buf
    return buf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--site", choices=("CN", "INTL"), required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--language", default="zh", choices=("zh", "en"))
    parser.add_argument("--wait-seconds", type=int, default=1800)
    args = parser.parse_args()
    if not ALIYUN.is_file():
        print("aliyun binary missing", file=sys.stderr)
        return 2

    base = Path("/tmp/aliyun-oauth")
    base.mkdir(mode=0o700, exist_ok=True)
    os.chmod(base, 0o700)
    callback_path = base / f"{args.profile}.callback"
    if callback_path.exists():
        callback_path.unlink()

    proc = subprocess.Popen(
        [
            str(ALIYUN),
            "configure",
            "--mode",
            "OAuth",
            "--profile",
            args.profile,
            "--no-browser",
            "--oauth-site-type",
            args.site,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
    )
    assert proc.stdin and proc.stdout
    proc.stdin.write(b"0\n" if args.site == "CN" else b"1\n")
    proc.stdin.flush()

    buf = read_until(
        proc,
        lambda b: b"Callback URL" in b and b"https://" in b,
        30,
    )
    text = buf.decode("utf-8", "replace")
    urls = re.findall(r"https://\S+", text)
    if not urls or proc.poll() is not None:
        print("oauth flow did not reach the callback prompt", file=sys.stderr)
        return 1
    print("AUTH_URL=" + urls[0])
    print("CALLBACK_FILE=" + str(callback_path))
    sys.stdout.flush()

    deadline = time.time() + args.wait_seconds
    while time.time() < deadline:
        if callback_path.exists() and callback_path.stat().st_size > 0:
            break
        if proc.poll() is not None:
            print("aliyun exited before the callback", file=sys.stderr)
            return 1
        time.sleep(0.4)
    else:
        proc.kill()
        print("timed out waiting for the callback file", file=sys.stderr)
        return 1

    callback = callback_path.read_text().strip()
    callback_path.unlink()
    proc.stdin.write((callback + "\n").encode())
    proc.stdin.flush()

    rest = bytearray()
    seen_region = False
    seen_language = False
    while True:
        chunk = proc.stdout.read(1)
        if not chunk:
            break
        rest += chunk
        if not seen_region and b"Default Region Id" in rest:
            proc.stdin.write((args.region + "\n").encode())
            proc.stdin.flush()
            seen_region = True
        if seen_region and not seen_language and b"Default Language" in rest:
            proc.stdin.write((args.language + "\n").encode())
            proc.stdin.flush()
            proc.stdin.close()
            seen_language = True
            while True:
                more = proc.stdout.read(4096)
                if not more:
                    break
                rest += more
            break
    proc.wait(timeout=60)
    cfg = Path.home() / ".aliyun" / "config.json"
    if cfg.exists():
        os.chmod(cfg, 0o600)
    tail = rest.decode("utf-8", "replace")
    ok = proc.returncode == 0 and "Configure Done!!!" in tail
    print(
        f"RESULT profile={args.profile} site={args.site} "
        f"region={args.region} language_written={seen_language} ok={ok}"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
