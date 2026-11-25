"""Run on fnOS as the service owner. Emit SQLite online backups to a tar stream."""
import contextlib
import sqlite3
import sys
import tarfile
import tempfile
from pathlib import Path

root = Path('/vol1/1000/docker')
groups = {
    'admin': (root / 'personal-voice-admin/data', ('config.db', 'devices.db', 'profile.db')),
    'brain': (root / 'personal-voice-runtime/brain-data', ('conversations.sqlite', 'profile.sqlite', 'search.sqlite')),
}
with tempfile.TemporaryDirectory(dir='/dev/shm') as temporary, tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz') as archive:
    for group, (source_dir, names) in groups.items():
        for name in names:
            source = source_dir / name
            target = Path(temporary) / (group + '-' + name)
            with contextlib.closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as live, contextlib.closing(sqlite3.connect(target)) as saved:
                live.backup(saved)
                if saved.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError(f'Integrity check failed for {group}/{name}')
            archive.add(target, arcname=group+'/'+name, recursive=False)
            target.unlink()
