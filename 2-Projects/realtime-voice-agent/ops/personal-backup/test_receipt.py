import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag
import backup
from receipt import store


class ReceiptTests(unittest.TestCase):
    def test_order_and_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'receipt.json'
            row = dict(schema=1, scope='personal-voice', databaseCount=6, archiveBytes=32768,
                       capturedAt='2026-11-28T05:00:00.000000Z', verifiedAt='2026-11-28T05:02:00.000000Z')
            target.write_text('{')
            store(target, row)
            self.assertEqual(json.loads(target.read_text()), row)
            older = dict(row, capturedAt='2026-11-28T04:00:00.000000Z', verifiedAt='2026-11-28T05:03:00.000000Z')
            store(target, older)
            self.assertEqual(json.loads(target.read_text()), row)
            with self.assertRaises(ValueError):
                store(target, dict(row, databaseCount=5))
            with self.assertRaises(ValueError):
                store(target, dict(row, filename='unexpected'))
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['receipt.json'])

    def test_restored_database_set_and_submitted_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dbfile = root/'fixture.sqlite'
            with contextlib.closing(sqlite3.connect(dbfile)) as db:
                db.execute('CREATE TABLE example (id INTEGER)')
            archive = root/'20261128T002345012345Z.xkdb'
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw,mode='w:gz') as tar:
                for name in backup.FILES:
                    tar.add(dbfile, arcname=name)
            key = AESGCM.generate_key(bit_length=256)
            nonce = os.urandom(12)
            body = AESGCM(key).encrypt(nonce,raw.getvalue(),backup.MAGIC)
            archive.write_bytes(backup.MAGIC + nonce + body)
            backup.verify(archive,key)
            with patch('backup.subprocess.run') as remote:
                backup.publish_receipt(archive)
                import shlex
                receipt = json.loads(shlex.split(remote.call_args.args[0][-1])[-1])
                self.assertEqual(receipt['archiveBytes'],archive.stat().st_size)
                self.assertEqual(receipt['capturedAt'],'2026-11-28T00:23:45.012345Z')
                self.assertEqual(receipt['databaseCount'],6)
                self.assertEqual(set(receipt),{'schema','scope','databaseCount','capturedAt','verifiedAt','archiveBytes'})
            archive.write_bytes(backup.MAGIC+nonce+bytes([body[0]^1])+body[1:])
            with self.assertRaises(InvalidTag):
                backup.verify(archive,key)


if __name__ == '__main__':
    unittest.main()
