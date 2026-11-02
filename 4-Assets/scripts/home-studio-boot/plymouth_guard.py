#!/usr/bin/python3
"""Finish the Plymouth handoff only for a verified, stable headless GDM boot."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


WAIT = "plymouth-quit-wait.service"
GDM = "gdm.service"


class GdmSettling(RuntimeError):
    """The only safe-to-retry precondition: GDM has just become active."""


class Host:
    def unit(self, name):
        result = subprocess.run(
            ["/usr/bin/systemctl", "show", name, "--no-pager",
             "--property=ActiveState,SubState,MainPID,Result,ExecMainStatus,ActiveEnterTimestampMonotonic"],
            check=True, text=True, capture_output=True, timeout=3)
        return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)

    def displays(self):
        return {str(p): p.read_text().strip() for p in Path("/sys/class/drm").glob("card*-*/status")}

    def daemon(self):
        pid = int(Path("/run/plymouth/pid").read_text().strip())
        if pid <= 1 or Path(f"/proc/{pid}/comm").read_text().strip() != "plymouthd":
            raise RuntimeError("Plymouth PID does not identify plymouthd")
        return pid, self.identity(pid)

    def identity(self, pid):
        try:
            # Field 22 (starttime), after the final ')' of field 2 (comm).
            stat = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return stat[19]
        except FileNotFoundError:
            return None

    def now(self):
        return time.monotonic()

    def sleep(self, seconds):
        time.sleep(seconds)

    def quit(self):
        return subprocess.run(["/usr/bin/plymouth", "quit"], timeout=10, check=False).returncode


def inspect(host):
    wait = host.unit(WAIT)
    if wait.get("ActiveState") == "active" and wait.get("SubState") == "exited" and wait.get("Result") == "success" and wait.get("ExecMainStatus") == "0":
        return {"action": "noop", "reason": "Plymouth wait already completed normally"}
    if wait.get("ActiveState") != "activating" or wait.get("SubState") != "start":
        raise RuntimeError("Plymouth wait is not in the expected activating/start state")
    gdm = host.unit(GDM)
    if gdm.get("ActiveState") != "active" or gdm.get("SubState") != "running" or int(gdm.get("MainPID", "0")) <= 1:
        raise RuntimeError("GDM is not active/running")
    entered = int(gdm.get("ActiveEnterTimestampMonotonic", "0")) / 1_000_000
    if entered <= 0:
        raise RuntimeError("GDM has no valid activation timestamp")
    if host.now() - entered < 10:
        raise GdmSettling("GDM has not been stable for at least 10 seconds")
    displays = host.displays()
    if not displays or any(value != "disconnected" for value in displays.values()):
        raise RuntimeError("Headless state unverified: require nonempty, all-disconnected DRM outputs")
    pid, identity = host.daemon()
    if identity is None:
        raise RuntimeError("Plymouth daemon disappeared during inspection; retry inspection")
    return {"action": "quit", "pid": pid, "identity": identity,
            "gdm_pid": gdm["MainPID"], "displays": displays}


def finish(host):
    try:
        plan = inspect(host)
    except GdmSettling:
        host.sleep(10)
        plan = inspect(host)
    if plan["action"] == "noop":
        return plan
    # Recheck state immediately before the only mutation, including hotplug/PID races.
    if inspect(host) != plan:
        raise RuntimeError("Boot state changed during inspection; refusing to quit Plymouth")
    result = host.quit()
    deadline = host.now() + 10
    while host.now() < deadline:
        wait = host.unit(WAIT)
        exited = host.identity(plan["pid"]) != plan["identity"]
        if exited and wait.get("ActiveState") == "active" and wait.get("SubState") == "exited" and wait.get("Result") == "success" and wait.get("ExecMainStatus") == "0":
            gdm = host.unit(GDM)
            if gdm.get("MainPID") != plan["gdm_pid"] or gdm.get("ActiveState") != "active":
                raise RuntimeError("Plymouth exited but GDM changed; manual verification required")
            return {**plan, "result": "completed", "quit_exit": result}
        host.sleep(0.25)
    raise RuntimeError(f"Plymouth quit exit={result}; daemon/wait completion not verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Read-only diagnosis; does not require root")
    args = parser.parse_args()
    try:
        if not args.check and os.geteuid() != 0:
            raise RuntimeError("Apply requires normal administrator authentication")
        print(json.dumps(inspect(Host()) if args.check else finish(Host()), sort_keys=True), flush=True)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({"result": "error", "reason": str(error)}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
