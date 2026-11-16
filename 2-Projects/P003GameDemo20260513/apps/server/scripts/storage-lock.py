#!/usr/bin/env python
"""Python 2.7/3 stdlib kernel lock supervisor. The inode is never removed.

The descriptor survives exec and fork: an orphan SSH writer keeps exclusion;
kernel process exit or host restart releases it without stale-PID guessing.
"""
from __future__ import print_function
import errno, fcntl, os, stat, sys, signal, subprocess, time

def main():
    lock, command = sys.argv[1], sys.argv[2:]
    if not command or not os.path.isabs(lock) or os.path.realpath(lock) != lock:
        return 2
    marker=os.environ.get('ARCHIVE_VOLUME_MARKER')
    volume=os.environ.get('ARCHIVE_VOLUME_ID')
    # This launcher is a NAS entry guard, not an optional generic mutex.
    if not marker or not volume or os.path.realpath(marker)!=marker:return 2
    st=os.lstat(marker)
    if not stat.S_ISREG(st.st_mode) or st.st_size>256 or st.st_dev!=os.stat(os.path.dirname(lock)).st_dev:return 2
    with open(marker) as f:
        if f.read().strip()!=volume:return 2
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        return 2
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError as e:
        if e.errno in (errno.EAGAIN, errno.EACCES):
            print('ARCHIVE_JOB_BUSY', file=sys.stderr)
            return 3
        raise
    fcntl.fcntl(fd, fcntl.F_SETFD, fcntl.fcntl(fd, fcntl.F_GETFD) & ~fcntl.FD_CLOEXEC)
    # SSH closes inherited descriptors. Keep a supervisor and a dedicated process
    # group so a killed shell cannot leave an unlocked SSH append in progress.
    timeout=int(os.environ.get('ARCHIVE_JOB_TIMEOUT_SEC','7200'))
    if timeout<1 or timeout>7200:raise ValueError('invalid_job_timeout')
    child = subprocess.Popen(command, close_fds=False, preexec_fn=os.setsid)
    def interrupted(signum, frame):
        raise SystemExit(124 if signum==signal.SIGALRM else 128+signum)
    for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP,signal.SIGALRM]:signal.signal(sig,interrupted)
    signal.alarm(timeout)
    try:
        result=child.wait()
        return result if result>=0 else 128-result
    finally:
        signal.alarm(0)
        # This process group was created by us; never signal a global PID/name.
        try:os.killpg(child.pid,signal.SIGTERM)
        except OSError as e:
            if e.errno!=errno.ESRCH:raise
        if child.poll() is None:
            end=time.time()+1
            while child.poll() is None and time.time()<end:time.sleep(.02)
        try:os.killpg(child.pid,signal.SIGKILL)
        except OSError as e:
            if e.errno!=errno.ESRCH:raise
        child.wait()

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception:
        print('ARCHIVE_LOCK_FAILED', file=sys.stderr)
        sys.exit(2)
