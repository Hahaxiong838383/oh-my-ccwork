"""Publish the latest verified backup's metadata to the private NAS admin volume."""
import fcntl
import json
import os
from datetime import datetime
from pathlib import Path
import sys
import tempfile

TARGET = Path('/vol1/1000/docker/personal-voice-admin/data/backup-receipt.json')


def store(target, receipt):
    fields = {'schema', 'scope', 'capturedAt', 'verifiedAt', 'databaseCount', 'archiveBytes'}
    if (set(receipt) != fields or receipt['scope'] != 'personal-voice' or receipt['schema'] != 1
            or receipt['databaseCount'] != 6 or type(receipt['archiveBytes']) is not int or receipt['archiveBytes'] <= 0):
        raise ValueError('无效备份回执')
    captured = datetime.strptime(receipt['capturedAt'], '%Y-%m-%dT%H:%M:%S.%fZ')
    verified = datetime.strptime(receipt['verifiedAt'], '%Y-%m-%dT%H:%M:%S.%fZ')
    if verified < captured:
        raise ValueError('备份及恢复验证的时间顺序错误')
    directory = os.open(target.parent, os.O_DIRECTORY | os.O_RDONLY)
    try:
        fcntl.flock(directory, fcntl.LOCK_EX)
        try:
            with target.open(encoding='utf-8') as previous:
                existing = json.load(previous)
            if (existing['scope'] == 'personal-voice' and existing['schema'] == 1
                    and datetime.strptime(existing['capturedAt'], '%Y-%m-%dT%H:%M:%S.%fZ') >= captured):
                return
        except (FileNotFoundError, KeyError, TypeError, ValueError):
            pass
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.backup-receipt-', delete=False) as stage:
            name = Path(stage.name)
            try:
                stage.write(json.dumps(receipt, sort_keys=True).encode('ascii') + b'\n')
                stage.flush()
                os.fchmod(stage.fileno(), 0o644)
                os.fsync(stage.fileno())
                os.replace(name, target)
                os.fsync(directory)
            finally:
                name.unlink(missing_ok=True)
    finally:
        os.close(directory)


if __name__ == '__main__':
    store(TARGET, json.loads(sys.argv[1]))
