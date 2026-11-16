#!/usr/bin/env python3
"""Explicit six-file release/rollback helper. Default is read-only verification.
No SSH, services, env edits, database access, deletion of records, or broad directory sync.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def atomic_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.records-r1-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(source.read_bytes())
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, 0o644)
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--apply', action='store_true', help='actually change the exact manifest files')
    args = parser.parse_args()
    manifest = json.loads((args.package / 'MANIFEST.json').read_text())
    rows = manifest['files']
    assert manifest['sn'] == 'BJP00326081002000031'
    assert len(rows) == 6 and len({r['path'] for r in rows}) == 6
    for row in rows:
        relative = Path(row['path'])
        assert not relative.is_absolute() and '..' not in relative.parts and relative.parts[0] == 'src'
        target = args.root / relative
        assert not target.is_symlink() and not any(p.is_symlink() for p in target.parents), 'symlink target refused'
        assert digest(args.package / 'candidate' / relative) == row['after_sha256'], 'package mismatch'
        actual = digest(target)
        if args.rollback:
            assert actual in (row['before_sha256'], row['after_sha256']), f'foreign drift: {relative}'
            if row['before_sha256'] is not None:
                assert digest(args.backup / relative) == row['before_sha256'], f'backup mismatch: {relative}'
        else:
            assert actual == row['before_sha256'], f'baseline drift: {relative}'
    if args.rollback:
        receipt = json.loads((args.backup / 'RELEASE.json').read_text())
        assert receipt['candidate'] == manifest['candidate'], 'wrong release backup'
    elif args.apply:
        args.backup.mkdir(parents=True, exist_ok=False)
        for row in rows:
            if row['before_sha256'] is not None:
                saved = args.backup / row['path']
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(args.root / row['path'], saved)
                assert digest(saved) == row['before_sha256']
        (args.backup / 'RELEASE.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if args.apply:
        for row in rows:
            target = args.root / row['path']
            if args.rollback:
                if digest(target) == row['before_sha256']:
                    continue
                if row['before_sha256'] is None:
                    target.unlink()  # Only our new file, already exact-hash checked.
                else:
                    atomic_copy(args.backup / row['path'], target)
            else:
                atomic_copy(args.package / 'candidate' / row['path'], target)
        for row in rows:
            assert digest(args.root / row['path']) == row['before_sha256' if args.rollback else 'after_sha256']
    print(json.dumps({'sn':manifest['sn'], 'candidate':manifest['candidate'], 'action':'rollback' if args.rollback else 'release', 'applied':args.apply, 'files':len(rows), 'database_modified':False, 'service_restarted':False}))


if __name__ == '__main__':
    main()
