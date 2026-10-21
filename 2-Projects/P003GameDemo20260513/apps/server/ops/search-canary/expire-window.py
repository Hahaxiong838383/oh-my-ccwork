#!/usr/bin/env python3
"""Fixed-deadline backstop. Never enables or renews a window; no credentials/log bodies."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import time


def close_db(path, deadline, now, production):
    if now < deadline:
        return 'not_due'
    # Refuse to create a missing DB. Conditional writes cannot close a newer window.
    db = sqlite3.connect('file:' + str(path) + '?mode=rw', uri=True, timeout=5)
    try:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute("SELECT value FROM runtime_flag WHERE key='p003.search.canary.expires_at_ms'").fetchone()
        if not row or row[0] != str(deadline):
            db.rollback()
            return 'different_window'
        keys = ['p003.search.canary.enabled'] if production else ['p003.search.enabled', 'p003.search.tools']
        for key in keys:
            db.execute('INSERT INTO runtime_flag(key,value,updated_at,updated_by,note) VALUES (?,\'0\',?,\'fixed-window-expiry\',\'expired\') ON CONFLICT(key) DO UPDATE SET value=\'0\',updated_at=excluded.updated_at,updated_by=excluded.updated_by,note=excluded.note', (key, now))
        db.commit()
        return 'closed'
    finally:
        db.close()


def close_worker(path, deadline, now):
    if now < deadline:
        return 'not_due'
    path = Path(path)
    value = json.loads(path.read_text())
    if value.get('expires_at_ms') != deadline:
        return 'different_window'
    value['enabled'] = False
    temp = path.with_suffix('.expiry.tmp')
    with temp.open('w') as f:
        os.chmod(temp, 0o600)
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    return 'closed'


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--mode', choices=['brain', 'worker'], required=True)
    p.add_argument('--deadline', type=int, required=True)
    a = p.parse_args()
    now = int(time.time() * 1000)
    if a.mode == 'brain':
        result = {'production': close_db('/opt/p003/server/data/config.db', a.deadline, now, True),
                  'candidate': close_db('/opt/p003/search-canary-20261021/brain/data/config.db', a.deadline, now, False)}
    else:
        result = {'worker': close_worker('/opt/p003-search-canary-20261021/window.json', a.deadline, now)}
    print(json.dumps({'at_ms': now, 'deadline': a.deadline, 'result': result}))
