#!/usr/bin/python3
"""Install or remove the bounded headless boot repair using normal sudo authentication."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

BASE = Path(__file__).resolve().parent
STATE = Path("/var/lib/home-studio-boot-guard")
MANIFEST = STATE / "manifest.json"
FILES = {
    "plymouth_guard.py": "/usr/local/libexec/home-studio-plymouth-guard.py",
    "home-studio-plymouth-guard.service": "/etc/systemd/system/home-studio-plymouth-guard.service",
    "home-studio-plymouth-guard.timer": "/etc/systemd/system/home-studio-plymouth-guard.timer",
    "90-home-studio-bounded-wait.conf": "/etc/systemd/system/plymouth-quit-wait.service.d/90-home-studio-bounded-wait.conf",
}
TIMER = "home-studio-plymouth-guard.timer"
SERVICE = "home-studio-plymouth-guard.service"


def run(*command):
    return subprocess.run(command, check=True, timeout=60)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def trusted_parent(path):
    for parent in (path.parent, *path.parent.parents):
        if parent.is_symlink():
            raise RuntimeError(f"Refusing symlink directory: {parent}")
        if parent.exists():
            stat = parent.stat()
            if stat.st_uid != 0 or stat.st_mode & 0o022:
                raise RuntimeError(f"System directory is not exclusively root-writable: {parent}")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)


def write_atomic(path, content, mode=0o644):
    trusted_parent(path)
    fd, name = tempfile.mkstemp(prefix=".boot-guard-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(content)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def owned_files(manifest):
    if set(manifest) != set(FILES.values()):
        raise RuntimeError("Manifest path set differs from this installer")
    for name, expected in manifest.items():
        path = Path(name)
        if path.is_symlink() or (path.exists() and digest(path.read_bytes()) != expected):
            raise RuntimeError(f"Installed file has changed; refusing to remove it: {path}")


def uninstall():
    if not MANIFEST.is_file():
        raise RuntimeError("No installation manifest; refusing to remove unmanaged files")
    manifest = json.loads(MANIFEST.read_text())
    owned_files(manifest)
    run("/usr/bin/systemctl", "disable", "--now", TIMER)
    run("/usr/bin/systemctl", "stop", SERVICE)
    for name in manifest:
        Path(name).unlink(missing_ok=True)
    run("/usr/bin/systemctl", "daemon-reload")
    MANIFEST.unlink()
    # Leave the empty root-owned state directory as a harmless installation record.
    print("Removed only this repair. GDM and business services were not restarted.")


def install():
    if MANIFEST.exists():
        manifest = json.loads(MANIFEST.read_text())
        owned_files(manifest)
        if any(not Path(name).is_file() for name in manifest):
            raise RuntimeError("Partial installation: use uninstall before retrying")
        if manifest != {destination: digest((BASE / source).read_bytes()) for source, destination in FILES.items()}:
            raise RuntimeError("Different package already installed; review and uninstall it first")
        run("/usr/bin/python3", "-I", FILES["plymouth_guard.py"])
        run("/usr/bin/systemctl", "enable", "--now", TIMER)
        return
    payload = {destination: (BASE / source).read_bytes() for source, destination in FILES.items()}
    for name in payload:
        path = Path(name)
        if path.exists() or path.is_symlink():
            raise RuntimeError(f"Existing unmanaged file: {path}; nothing changed")
        trusted_parent(path)
    if STATE.is_symlink():
        raise RuntimeError("Refusing symlink state directory")
    trusted_parent(MANIFEST)
    os.chmod(STATE, 0o700)
    manifest = {name: digest(content) for name, content in payload.items()}
    write_atomic(MANIFEST, (json.dumps(manifest, indent=2) + "\n").encode(), 0o600)
    try:
        guard = FILES["plymouth_guard.py"]
        write_atomic(Path(guard), payload[guard])
        # Finish the CURRENT stuck job before reloading its new timeout: the job
        # may already be older than 180 seconds. Never start plymouth-quit.service.
        run("/usr/bin/python3", "-I", guard)
        for name, content in payload.items():
            if name != guard:
                write_atomic(Path(name), content)
        run("/usr/bin/systemd-analyze", "verify", FILES[SERVICE], FILES[TIMER], "plymouth-quit-wait.service")
        run("/usr/bin/systemctl", "daemon-reload")
        run("/usr/bin/systemctl", "enable", "--now", TIMER)
        run("/usr/bin/systemctl", "is-enabled", TIMER)
        run("/usr/bin/systemctl", "is-active", TIMER)
        run("/usr/bin/systemctl", "show", "plymouth-quit-wait.service", "--property=TimeoutStartUSec,ActiveState,SubState,Result,ExecMainStatus")
        os.sync()
        print("Installed. Verify system state/health now and again after a real reboot.")
    except Exception:
        # All targets were absent before install. Remove only matching new files;
        # preserve evidence rather than overwrite a concurrent administrator edit.
        owned_files(manifest)
        subprocess.run(["/usr/bin/systemctl", "disable", "--now", TIMER], timeout=30, check=False)
        subprocess.run(["/usr/bin/systemctl", "stop", SERVICE], timeout=30, check=False)
        for name in manifest:
            Path(name).unlink(missing_ok=True)
        run("/usr/bin/systemctl", "daemon-reload")
        MANIFEST.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "uninstall"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Requires sudo authentication; never put your password in chat or command arguments")
    if socket.gethostname() != "hahaxiong-home-studio":
        parser.error("This repair is scoped to hahaxiong-home-studio")
    (install if args.action == "install" else uninstall)()


if __name__ == "__main__":
    main()
