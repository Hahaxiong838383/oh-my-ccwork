import importlib.util, tempfile, sqlite3, unittest, json
from pathlib import Path
from unittest.mock import patch
MODULE = Path(__file__).resolve().with_name('analytics-backup.py')
spec = importlib.util.spec_from_file_location('analytics_backup', MODULE)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
class OnlineBackupTests(unittest.TestCase):
    def test_live_wal_restore_preserves_committed_events_and_dedupe(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d); db=sqlite3.connect(r/'analytics.db'); db.execute('PRAGMA journal_mode=WAL'); db.executescript('CREATE TABLE event(id TEXT PRIMARY KEY); CREATE TABLE seen(id TEXT PRIMARY KEY);'); db.execute("INSERT INTO event VALUES ('accepted-1')"); db.execute("INSERT INTO seen VALUES ('accepted-1')"); db.commit()
            m=backup.create_backup(r/'analytics.db',r/'backups',keep=2)
            target=r/'isolated-restored.db'; backup.restore_backup(Path(m['backup_path']),target)
            restored=sqlite3.connect(target); self.assertEqual(restored.execute('SELECT id FROM seen').fetchall(), [('accepted-1',)]); self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            with self.assertRaises(FileExistsError): backup.restore_backup(Path(m['backup_path']),target)
            restored.close(); db.close()
    def test_retention_is_scoped_and_source_missing_never_creates_empty_db(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d); dest=r/'backups'; dest.mkdir(); (dest/'unrelated.db').write_bytes(b'leave-me'); db=sqlite3.connect(r/'analytics.db'); db.execute('CREATE TABLE event(id TEXT)'); db.commit(); db.close()
            for _ in range(3): backup.create_backup(r/'analytics.db',dest,keep=2)
            self.assertEqual(len(list(dest.glob('analytics-*.sqlite3'))),2); self.assertEqual((dest/'unrelated.db').read_bytes(),b'leave-me')
            with self.assertRaises(FileNotFoundError): backup.create_backup(r/'missing.db',dest,keep=2)
            self.assertFalse((r/'missing.db').exists())
    def test_exclusive_create_race_preserves_other_process_target(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / 'source.db'
            with sqlite3.connect(source) as db:
                db.execute('CREATE TABLE event(id TEXT)')
            target = root / 'someone-else.db'
            original_open = Path.open
            def race_open(path, mode='r', *args, **kwargs):
                if path == target and mode == 'xb':
                    with original_open(target, 'wb') as handle:
                        handle.write(b'other-process-owned')
                return original_open(path, mode, *args, **kwargs)
            with patch.object(Path, 'open', race_open):
                with self.assertRaises(FileExistsError):
                    backup._copy_checked(source, target)
            self.assertTrue(target.exists(), 'must preserve the competing process target')
            self.assertEqual(target.read_bytes(), b'other-process-owned')

    def test_corrupt_source_produces_no_published_backup(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d); (r/'bad.db').write_bytes(b'not-sqlite')
            with self.assertRaises(sqlite3.DatabaseError): backup.create_backup(r/'bad.db',r/'backups',keep=2)
            self.assertEqual(list((r/'backups').glob('analytics-*.sqlite3')),[])
if __name__ == '__main__': unittest.main()
