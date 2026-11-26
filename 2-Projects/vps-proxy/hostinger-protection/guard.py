#!/usr/bin/python3
"""Hostinger 磁盘/内存巡检。只清理 APT 缓存和已归档的系统日志。"""
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import time

STATE = Path("/var/lib/hostinger-guard")
GIB = 1024**3
TRACK = ["/var/cache", "/var/log", "/var/lib", "/tmp", "/home/hahaxiong83"]
def disk_level(free, inodes):
    if free < 5 * GIB or inodes < 2:
        return 3
    if free < 10 * GIB or inodes < 5:
        return 2
    return int(free < 20 * GIB or inodes < 10)

def save(path, value):
    tmp = path.with_suffix(".new")
    tmp.write_text(value)
    tmp.replace(path)

def usage():
    result = subprocess.run(["timeout", "40", "ionice", "-c3", "du", "-x", "-B1", "-s", *TRACK],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return {p: int(v) for v, p in (line.split("\t", 1) for line in result.stdout.splitlines())}

def sample():
    st = os.statvfs("/")
    return shutil.disk_usage("/").free, 100 * st.f_favail / st.f_files

def main():
    now = int(time.time())
    path = STATE / "state.json"
    old = json.loads(path.read_text()) if path.exists() else {}
    free, inodes = sample()
    level = disk_level(free, inodes)
    cleaned = old.get("cleaned", 0)
    attempt = old.get("attempt", 0)
    cleanup_error = old.get("cleanup_error", "") if level >= 2 else ""
    if level >= 2 and now - cleaned >= 21600 and now - attempt >= 600:
        attempt = now
        failed = []
        for cmd in (["apt-get", "-o", "DPkg::Lock::Timeout=5", "clean"],
                    ["journalctl", "--vacuum-size=256M"]):
            try:
                subprocess.run(cmd, check=True, timeout=90)
            except (OSError, subprocess.SubprocessError) as error:
                failed.append(cmd[0])
                print(f"cache cleanup failed: {error}", flush=True)
        cleanup_error = ", ".join(failed)
        if not failed:
            cleaned = now
        after, inodes = sample()
        print(f"safe cleanup: free bytes {free} -> {after}", flush=True)
        free, level = after, disk_level(after, inodes)
    mem = int(next(x.split()[1] for x in Path("/proc/meminfo").read_text().splitlines()
                   if x.startswith("MemAvailable:"))) * 1024
    low_since = (old.get("low_since") or now) if mem < GIB else 0
    memory_alert = bool(low_since and now - low_since >= 120)
    notices = []
    if cleanup_error:
        notices.append("cache cleanup failed: " + cleanup_error)
    if level:
        notices.append(f"disk level {level}: free {free/GIB:.1f} GiB, free inodes {inodes:.1f}%")
    if memory_alert:
        notices.append(f"memory: available {mem/1024**2:.0f} MiB for at least 2 minutes")
        if not old.get("memory_alert"):
            processes = subprocess.check_output(["ps", "-eo", "comm,rss", "--sort=-rss"], text=True)
            print("\n".join(processes.splitlines()[:9]), flush=True)
    sizes = old.get("sizes", {})
    scanned = old.get("scanned", 0)
    if now - scanned >= 86400 or (level and level != old.get("level")):
        current = usage()
        if level:
            for p in sorted(current, key=current.get, reverse=True):
                print(f"{p} bytes={current[p]} delta={current[p]-sizes[p] if p in sizes else 'unknown'}")
        sizes, scanned = current, now
    receipt = Path("/home/hahaxiong83/.local/state/hostinger-backup/receipt")
    try:
        owner = receipt.parent.parent.parent.parent.stat().st_uid
        fd = os.open(receipt, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != owner:
                raise ValueError("invalid receipt")
            last = int(stream.read(32).strip())
        overdue = not 0 <= now - last <= 43200
    except (OSError, ValueError):
        overdue = True
    if overdue:
        notices.append("backup: no success receipt within 12 hours")
    status = (level, memory_alert, overdue, cleanup_error)
    previous = (old.get("level", 0), old.get("memory_alert", False), old.get("overdue", False), old.get("cleanup_error", ""))
    if status != previous or (notices and now - old.get("announced", 0) >= 43200):
        msg = "Hostinger: " + ("; ".join(notices) if notices else "resource levels recovered")
        print(msg, flush=True)
        subprocess.run(["wall"], input=msg+"\n", text=True, timeout=10)
        announced = now
    else:
        announced = old.get("announced", 0)
    save(STATE / "notice", "\n".join(notices) + ("\n" if notices else ""))
    save(path, json.dumps(dict(level=level, memory_alert=memory_alert, low_since=low_since,
                               attempt=attempt, cleanup_error=cleanup_error, overdue=overdue, cleaned=cleaned, sizes=sizes, scanned=scanned, announced=announced,
                               checked=now)))
if __name__ == "__main__":
    main()
