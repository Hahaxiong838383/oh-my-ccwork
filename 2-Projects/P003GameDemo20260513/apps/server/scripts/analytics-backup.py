#!/usr/bin/env python3
"""Consistent online SQLite backup and isolated restore. Never restore over live data."""
import argparse
import hashlib
import json
import os
import math
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


def budget_seconds(size, rate_bytes_s=16*1024**2):
    if size < 0 or rate_bytes_s <= 0:
        raise ValueError('invalid_backup_budget')
    return min(7200, max(300, math.ceil(180 + 2 * size / rate_bytes_s)))


def _check(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError('analytics_backup_timeout')


def _sha(path, deadline=None, on_progress=None):
    h = hashlib.sha256()
    done=0
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            _check(deadline)
            h.update(block)
            done+=len(block)
            if on_progress:on_progress({'phase':'checksum','bytes_done':done,'bytes_total':path.stat().st_size})
    return h.hexdigest()


def _sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _copy_checked(source, target, deadline=None, on_progress=None):
    source = Path(source).resolve(strict=True)
    target = Path(target)
    if target.exists():
        raise FileExistsError(target)
    if deadline is None:
        deadline = time.monotonic() + budget_seconds(source.stat().st_size)
    _check(deadline)
    def progress(status, remaining, total):
        _check(deadline)
        if on_progress: on_progress({'phase':'copy','remaining_pages':remaining,'total_pages':total})
    created_identity = None
    try:
        with target.open('xb') as f:
            identity = os.fstat(f.fileno())
            created_identity = (identity.st_dev, identity.st_ino)
            os.fchmod(f.fileno(), 0o600)
        src = sqlite3.connect('file:' + quote(str(source)) + '?mode=ro', uri=True, timeout=3)
        dst = sqlite3.connect(target, timeout=3)
        try:
            # Fresh isolated destination only: its default 2MiB cache makes full
            # index consistency checks thrash on the measured 504MB trial DB.
            # Bound the verification pager to 128MiB; the live source stays RO.
            dst.execute('PRAGMA cache_size=-131072')
            def integrity_progress():
                if on_progress:on_progress({'phase':'integrity_check'})
                return 1 if time.monotonic() >= deadline else 0
            dst.set_progress_handler(integrity_progress, 10000)
            src.backup(dst, pages=256, progress=progress, sleep=0.05)
            check = dst.execute('PRAGMA integrity_check').fetchall()
            if check != [('ok',)]:
                raise sqlite3.DatabaseError('analytics_backup_integrity_failed')
            dst.commit()
            _check(deadline)
        finally:
            dst.close()
            src.close()
        with target.open('rb') as f:
            os.fsync(f.fileno())
    except Exception:
        if created_identity is not None:
            try:
                current = target.lstat()
                if (current.st_dev, current.st_ino) == created_identity:
                    target.unlink()
            except FileNotFoundError:
                pass
        raise


def create_backup(database, destination, keep=2, timeout_seconds=None, on_progress=None):
    database = Path(database).resolve(strict=True)
    destination = Path(destination)
    if keep < 1 or keep > 100:
        raise ValueError('keep must be 1..100')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    started = time.monotonic()
    budget = budget_seconds(database.stat().st_size) if timeout_seconds is None else timeout_seconds
    if not 0 <= budget <= 7200: raise ValueError('invalid_backup_budget')
    deadline = started + budget
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    final = destination / ('analytics-' + stamp + '.sqlite3')
    temp = destination / ('.' + final.name + '.partial')
    _copy_checked(database, temp, deadline, on_progress)
    owned=temp.stat()
    try:
        meta = {'schema_version': 1, 'created_at_utc': stamp, 'backup_path': str(final.resolve()),
                'sha256': _sha(temp, deadline,on_progress), 'bytes': temp.stat().st_size, 'integrity_check': 'ok',
                'budget_seconds':budget, 'elapsed_seconds':time.monotonic()-started}
    except Exception:
        current=temp.lstat()
        if (current.st_dev,current.st_ino)==(owned.st_dev,owned.st_ino):temp.unlink()
        raise
    os.replace(temp, final)
    manifest = final.with_suffix('.json')
    mt = manifest.with_suffix('.json.partial')
    with mt.open('x') as f:
        os.chmod(mt, 0o600)
        json.dump(meta, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(mt, manifest)
    _sync_dir(destination)
    # Only prune files created by this tool; unrelated release/DB backups are untouched.
    backups = sorted(destination.glob('analytics-????????T????????????Z.sqlite3'), reverse=True)
    for old in backups[keep:]:
        if old.with_suffix('.pin').exists(): continue
        old.unlink()
        old.with_suffix('.json').unlink(missing_ok=True)
    _sync_dir(destination)
    return meta


def restore_backup(source, target, timeout_seconds=None):
    source = Path(source).resolve(strict=True)
    target = Path(target)
    if target.exists():
        raise FileExistsError(target)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    budget=budget_seconds(source.stat().st_size) if timeout_seconds is None else timeout_seconds
    if not 0 <= budget <= 7200: raise ValueError('invalid_backup_budget')
    deadline=time.monotonic()+budget
    _copy_checked(source, target, deadline)
    _sync_dir(target.parent)
    return {'restored_path': str(target.resolve()), 'integrity_check': 'ok', 'sha256': _sha(target,deadline)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--database', type=Path)
    p.add_argument('--destination', type=Path)
    p.add_argument('--keep', type=int, default=2)
    p.add_argument('--timeout-seconds',type=float)
    p.add_argument('--restore', type=Path)
    p.add_argument('--restore-to', type=Path)
    a = p.parse_args()
    if a.restore and a.restore_to:
        result = restore_backup(a.restore, a.restore_to,a.timeout_seconds)
    elif a.database and a.destination:
        last=[0]
        def report(value):
            if time.monotonic()-last[0]>=5:
                import sys
                print(json.dumps(value),file=sys.stderr,flush=True);last[0]=time.monotonic()
        result = create_backup(a.database, a.destination, a.keep,a.timeout_seconds,report)
    else:
        p.error('use --database/--destination or --restore/--restore-to')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
