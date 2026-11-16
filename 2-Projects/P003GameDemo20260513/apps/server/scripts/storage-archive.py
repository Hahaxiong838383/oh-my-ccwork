#!/usr/bin/env python3
"""Immutable archive spool and forced-command SSH gateway. No live DB writes.

Publish only closed files/consistent backups. The NAS can list, fetch a manifest,
read a known payload at a byte offset, and acknowledge its exact hash and size.
Acknowledgement never deletes a source. No shell or user-supplied filesystem path
is reachable through the gateway.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys
import time
import uuid

ID = re.compile(r'^[a-f0-9]{32}$')
HASH = re.compile(r'^[a-f0-9]{64}$')
KINDS = {'analytics_backup', 'ark_checkpoint', 'transfer_probe'}
MAX_BYTES = 256 * 1024**3


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sha(path, deadline=None, on_progress=None):
    h = hashlib.sha256()
    done=0
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            if deadline is not None and time.monotonic()>=deadline:raise TimeoutError('archive_publish_timeout')
            h.update(block)
            done+=len(block)
            if on_progress:on_progress({'phase':'publish_checksum','bytes_done':done,'bytes_total':path.stat().st_size})
    return h.hexdigest()


def write_json(path, value):
    temp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    with temp.open('x') as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump(value, f, sort_keys=True)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    sync_dir(path.parent)


def validate(m):
    if not isinstance(m, dict) or set(m) != {'schema_version', 'archive_id', 'kind', 'created_at_ms', 'record_count', 'bytes', 'sha256', 'source_range'}:
        raise ValueError('invalid_manifest_fields')
    if m['schema_version'] != 1 or type(m['schema_version']) is not int or not isinstance(m['archive_id'], str) or not ID.fullmatch(m['archive_id']):
        raise ValueError('invalid_manifest_id')
    if m['kind'] not in KINDS or not isinstance(m['sha256'], str) or not HASH.fullmatch(m['sha256']):
        raise ValueError('invalid_manifest_kind_or_hash')
    for key in ['created_at_ms', 'record_count', 'bytes']:
        if type(m[key]) is not int or m[key] < 0 or m[key] > 2**53 - 1:
            raise ValueError('invalid_manifest_number')
    if not 0 < m['bytes'] <= MAX_BYTES or not isinstance(m['source_range'], dict) or len(json.dumps(m).encode()) > 8192:
        raise ValueError('invalid_manifest_range_or_size')
    return m


class Spool:
    def __init__(self, root):
        self.root = Path(root).absolute()
        if self.root.resolve() != self.root:
            raise ValueError('spool_symlink')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in ['pending', 'published', 'receipts']:
            p = self.root / name
            if p.is_symlink():
                raise ValueError('spool_symlink')
            p.mkdir(exist_ok=True, mode=0o700)
        sync_dir(self.root)

    @contextmanager
    def lock(self, shared=False):
        fd = os.open(self.root / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def package(self, archive_id):
        if not isinstance(archive_id, str) or not ID.fullmatch(archive_id):
            raise ValueError('invalid_archive_id')
        p = self.root / 'published' / archive_id
        if p.is_symlink():
            raise ValueError('package_symlink')
        return p

    @staticmethod
    def regular(path):
        st = path.lstat()
        if not stat.S_ISREG(st.st_mode):
            raise ValueError('not_regular_file')
        return st

    def manifest(self, archive_id):
        p = self.package(archive_id) / 'manifest.json'
        if self.regular(p).st_size > 8192:
            raise ValueError('manifest_too_large')
        m = validate(json.loads(p.read_text()))
        if m['archive_id'] != archive_id:
            raise ValueError('manifest_id_mismatch')
        return m

    def list(self):
        with self.lock(shared=True):
            return [self.manifest(p.name) for p in sorted((self.root / 'published').iterdir()) if ID.fullmatch(p.name) and (p/'payload.bin').exists()]

    def publish(self, source, kind, record_count, source_range):
        source = Path(source)
        info = self.regular(source)
        m = validate({'schema_version': 1, 'archive_id': uuid.uuid4().hex,
                      'kind': kind, 'created_at_ms': int(time.time() * 1000),
                      'record_count': record_count, 'bytes': info.st_size,
                      'sha256': '0' * 64, 'source_range': source_range})
        with self.lock():
            # Keep a failed staging directory for diagnosis; it is never listed.
            stage = self.root / 'pending' / m['archive_id']
            stage.mkdir(mode=0o700)
            payload = stage / 'payload.bin'
            with source.open('rb') as src, payload.open('xb') as dst:
                os.fchmod(dst.fileno(), 0o600)
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())
            if source.stat().st_size != info.st_size or source.stat().st_mtime_ns != info.st_mtime_ns or payload.stat().st_size != info.st_size:
                raise ValueError('source_changed_during_publish')
            m['sha256'] = sha(payload)
            write_json(stage / 'manifest.json', m)
            payload.chmod(0o400)
            os.rename(stage, self.package(m['archive_id']))
            sync_dir(self.root / 'pending')
            sync_dir(self.root / 'published')
            return m

    def read(self, archive_id, offset, output):
        with self.lock(shared=True):
            m = self.manifest(archive_id)
            if type(offset) is not int or not 0 <= offset <= m['bytes']:
                raise ValueError('invalid_offset')
            p = self.package(archive_id) / 'payload.bin'
            if self.regular(p).st_size != m['bytes'] or sha(p) != m['sha256']:
                raise ValueError('published_payload_corrupt')
            with p.open('rb') as f:
                f.seek(offset)
                shutil.copyfileobj(f, output)
            return m['bytes'] - offset

    def publish_prepared(self, source, manifest, deadline=None, on_progress=None):
        """Adopt a closed same-volume backup, recovering all rename crash points.

        Caller persists this exact manifest before entering and owns its job lock.
        No full payload copy: live DB + previous backup + building backup.
        """
        m = validate(manifest); source = Path(source)
        with self.lock():
            final = self.package(m['archive_id'])
            if final.exists():
                if self.manifest(m['archive_id']) != m: raise ValueError('prepared_manifest_changed')
                payload=final/'payload.bin'
                if self.regular(payload).st_size!=m['bytes'] or sha(payload,deadline,on_progress)!=m['sha256']:raise ValueError('prepared_payload_corrupt')
                for p in [payload,final/'manifest.json']:
                    self.regular(p)
                    with p.open('rb') as f:os.fsync(f.fileno())
                sync_dir(final);sync_dir(self.root/'pending');sync_dir(self.root/'published')
                return m
            stage = self.root/'pending'/m['archive_id']
            if stage.is_symlink(): raise ValueError('stage_symlink')
            stage.mkdir(exist_ok=True,mode=0o700)
            payload = stage/'payload.bin'
            if not payload.exists():
                self.regular(source)
                os.rename(source,payload)
                sync_dir(source.parent);sync_dir(stage)
            if self.regular(payload).st_size != m['bytes'] or sha(payload,deadline,on_progress) != m['sha256']:
                raise ValueError('prepared_payload_corrupt')
            with payload.open('rb') as f: os.fsync(f.fileno())
            payload.chmod(0o400)
            write_json(stage/'manifest.json',m)
            os.rename(stage,final);sync_dir(self.root/'pending');sync_dir(self.root/'published')
            return m

    def receipt(self, m):
        p=self.root/'receipts'/(m['archive_id']+'.json')
        if not p.exists(): return None
        self.regular(p);r=json.loads(p.read_text())
        if any(r.get(k)!=m[k] for k in ['archive_id','sha256','bytes','record_count']):
            raise ValueError('stored_receipt_mismatch')
        if type(r.get('verified_at_ms')) is not int or r['verified_at_ms']<0: raise ValueError('invalid_receipt_time')
        return r

    def ack(self, archive_id, digest, size, record_count):
        with self.lock():
            m = self.manifest(archive_id)
            if type(size) is not int or size != m['bytes'] or digest != m['sha256'] or type(record_count) is not int or record_count != m['record_count']:
                raise ValueError('receipt_mismatch')
            p = self.root / 'receipts' / (archive_id + '.json')
            if p.exists() or p.is_symlink():
                self.regular(p)
                old = json.loads(p.read_text())
                if any(old.get(k) != m[k] for k in ['archive_id', 'sha256', 'bytes', 'record_count']):
                    raise ValueError('stored_receipt_mismatch')
                return old
            receipt = {k: m[k] for k in ['archive_id', 'sha256', 'bytes', 'record_count']}
            receipt['verified_at_ms'] = int(time.time() * 1000)
            write_json(p, receipt)
            return receipt


def gateway(spool, command, output):
    parts = shlex.split(command)
    if parts == ['list']:
        result = spool.list()
    elif len(parts) == 2 and parts[0] == 'meta':
        result = spool.manifest(parts[1])
    elif len(parts) == 3 and parts[0] == 'read' and re.fullmatch(r'[0-9]{1,12}', parts[2]):
        spool.read(parts[1], int(parts[2]), output)
        return
    elif len(parts) == 5 and parts[0] == 'ack' and HASH.fullmatch(parts[2]) and all(re.fullmatch(r'[0-9]{1,12}', x) for x in parts[3:]):
        result = spool.ack(parts[1], parts[2], int(parts[3]), int(parts[4]))
    else:
        raise ValueError('archive_command_not_allowed')
    output.write((json.dumps(result, sort_keys=True) + '\n').encode())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--gateway', action='store_true')
    p.add_argument('--publish', type=Path)
    p.add_argument('--kind', choices=sorted(KINDS), default='analytics_backup')
    p.add_argument('--record-count', type=int, default=0)
    p.add_argument('--source-range', default='{}')
    a = p.parse_args()
    spool = Spool(a.root)
    if a.gateway:
        gateway(spool, os.environ.get('SSH_ORIGINAL_COMMAND', ''), sys.stdout.buffer)
    elif a.publish:
        print(json.dumps(spool.publish(a.publish, a.kind, a.record_count, json.loads(a.source_range))))
    else:
        p.error('choose --gateway or --publish')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        # No paths, command bodies, payload or credentials in the error response.
        print('ARCHIVE_OPERATION_FAILED:' + type(e).__name__, file=sys.stderr)
        raise SystemExit(1)
