#!/usr/bin/env python3
"""Linux-only contention probe: real util-linux flock, temporary paths, no service start."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

if sys.platform != "linux" or not Path("/usr/bin/flock").is_file():
    print("SKIP: Linux /usr/bin/flock required; no simulated lock result")
    sys.exit(77)

wrapper = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("analytics-maintenance.sh")).resolve()
with tempfile.TemporaryDirectory(prefix="analytics-maintenance-lock-") as temporary:
    root = Path(temporary)
    (root / "data").mkdir()
    env = {**os.environ, "ANALYTICS_SERVER_ROOT": str(root)}
    with (root / "data/analytics-maintenance.lock").open("w") as holder:
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        rollup = subprocess.run(["/bin/bash", str(wrapper), "rollup"], env=env,
                                capture_output=True, text=True, timeout=5)
        assert rollup.returncode == 0, rollup.stderr
        skipped = json.loads(rollup.stdout)
        assert skipped == {"ok": True, "mode": "rollup", "skipped": True,
                           "reason": "maintenance_lock_busy"}, skipped
        # Backup must enter its own lock even while rollup holds the maintenance lock.
        independent = subprocess.run(["/bin/bash", str(wrapper), "backup"], env={**env,"ANALYTICS_NODE_PATH":"/usr/bin/true","ANALYTICS_ENV_FILE":"ignored"},capture_output=True,text=True,timeout=5)
        assert independent.returncode == 0, independent.stderr
    with (root / "data/analytics-backup.lock").open("w") as holder:
        fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        started = time.monotonic()
        backup = subprocess.run(["/bin/bash", str(wrapper), "backup"], env=env,
                                capture_output=True, text=True, timeout=25)
        waited = time.monotonic() - started
        assert backup.returncode != 0, "contended backup must not report success"
        assert 19 <= waited < 25, f"backup wait must be bounded to 20s, got {waited}"
        failed = json.loads(backup.stdout)
        assert failed == {"ok": False, "mode": "backup", "skipped": True,
                          "reason": "maintenance_lock_timeout"}, failed
print("PASS: real flock contention: rollup explicit skip; backup bounded wait then nonzero timeout")
