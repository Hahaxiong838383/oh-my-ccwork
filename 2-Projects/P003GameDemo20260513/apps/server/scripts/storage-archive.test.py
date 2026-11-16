"""Archive protocol tests against real files; never touches production paths."""
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).with_name('storage-archive.py')


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(MODULE.exists(), 'archive protocol is not implemented')
        spec = importlib.util.spec_from_file_location('archive', MODULE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / 'source'
        self.source.write_bytes(b'committed-record\n' * 100)
        self.spool = self.module.Spool(self.root / 'spool')

    def publish(self):
        return self.spool.publish(self.source, 'transfer_probe', 100, {'from_ms': 1, 'to_ms': 2})

    def test_publish_immutable_copy_and_resume_exact_offset(self):
        meta = self.publish()
        self.source.write_bytes(b'changed after publication')
        data = io.BytesIO()
        self.spool.read(meta['archive_id'], 13, data)
        self.assertEqual(data.getvalue(), (b'committed-record\n' * 100)[13:])
        self.assertEqual(self.spool.list(), [meta])
        self.assertEqual(meta['sha256'], hashlib.sha256(b'committed-record\n' * 100).hexdigest())
        self.assertEqual(self.spool.read(meta['archive_id'], meta['bytes'], io.BytesIO()), 0)
        with self.assertRaises(ValueError):
            self.spool.read(meta['archive_id'], meta['bytes'] + 1, io.BytesIO())

    def test_ack_lost_response_retry_is_idempotent_and_does_not_delete_source(self):
        m = self.publish()
        first = self.spool.ack(m['archive_id'], m['sha256'], m['bytes'], m['record_count'])
        again = self.module.Spool(self.root / 'spool').ack(m['archive_id'], m['sha256'], m['bytes'], m['record_count'])
        self.assertEqual(first, again)
        self.assertEqual(self.spool.manifest(m['archive_id']), m)
        self.assertTrue((self.root / 'spool' / 'published' / m['archive_id'] / 'payload.bin').exists())

    def test_ack_requires_exact_known_package(self):
        m = self.publish()
        for args in [(m['archive_id'], '0' * 64, m['bytes']),
                     (m['archive_id'], m['sha256'], m['bytes'] - 1),
                     ('a' * 32, m['sha256'], m['bytes'])]:
            with self.assertRaises((ValueError, FileNotFoundError)):
                self.spool.ack(*args, m['record_count'])
        with self.assertRaises(ValueError):
            self.spool.ack(m['archive_id'], m['sha256'], m['bytes'], m['record_count'] + 1)
        self.assertEqual(list((self.root / 'spool' / 'receipts').glob('*.json')), [])

    def test_interrupted_publish_is_not_visible_or_ackable(self):
        def interrupted(source, target):
            target.write(b'partial')
            raise OSError('simulated interrupted write')
        with patch.object(self.module.shutil, 'copyfileobj', interrupted):
            with self.assertRaises(OSError):
                self.publish()
        self.assertEqual(self.module.Spool(self.root / 'spool').list(), [])
        self.assertEqual(len(self.publish()['archive_id']), 32)

    def test_traversal_symlink_and_corruption_fail_closed(self):
        for value in ['../source', '/tmp/test', 'a' * 32 + '/x', 'A' * 32]:
            with self.assertRaises(ValueError):
                self.spool.manifest(value)
        m = self.publish()
        payload = self.root / 'spool' / 'published' / m['archive_id'] / 'payload.bin'
        payload.chmod(0o600)
        payload.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            self.spool.read(m['archive_id'], 0, io.BytesIO())
        payload.unlink()
        payload.symlink_to(self.source)
        with self.assertRaises(ValueError):
            self.spool.read(m['archive_id'], 0, io.BytesIO())

    def test_single_publisher_lock_and_gateway_allowlist(self):
        with (self.root / 'spool' / '.lock').open('a') as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.publish()
        for command in ['cat /etc/passwd', 'list; id', 'read ../source 0', 'read ' + 'a'*32 + ' -1', 'ack a b 1', 'list extra']:
            with self.assertRaises((ValueError, FileNotFoundError)):
                self.module.gateway(self.spool, command, io.BytesIO())

    def test_manifest_validation_rejects_bool_and_oversized_fields(self):
        for count in [-1, True, 1.5]:
            with self.assertRaises(ValueError):
                self.spool.publish(self.source, 'transfer_probe', count, {})
        with self.assertRaises(ValueError):
            self.spool.publish(self.source, 'other', 1, {})
        with self.assertRaises(ValueError):
            self.spool.publish(self.source, 'transfer_probe', 1, {'x': 'a' * 10000})


if __name__ == '__main__':
    unittest.main()
