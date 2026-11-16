"""Integration tests for export scheduling, crash recovery and source retention."""
import importlib.util, json, sqlite3, tempfile, unittest, time
from pathlib import Path
from unittest.mock import patch

def load(name):
    path=Path(__file__).with_name(name+'.py');s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

class JobTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(Path(__file__).with_name('storage-backup-job.py').exists(),'backup export job not implemented')
        self.job=load('storage-backup-job');self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
        self.db=self.root/'live.db'
        with sqlite3.connect(self.db) as db:db.executescript('CREATE TABLE events(id TEXT PRIMARY KEY); INSERT INTO events VALUES("first"); CREATE TABLE seen(id TEXT PRIMARY KEY); INSERT INTO seen VALUES("first");')
        self.spool=self.job.archive.Spool(self.root/'spool')
    def tearDown(self):
        if hasattr(self,'tmp'):self.tmp.cleanup()
    def runjob(self,now=1800000000000):return self.job.run(self.db,self.root/'spool',now_ms=now,reserve_bytes=0)
    def ack(self,m):return self.spool.ack(m['archive_id'],m['sha256'],m['bytes'],m['record_count'])
    def test_unacknowledged_package_blocks_duplicate_full_backup(self):
        first=self.runjob();self.assertEqual(first['state'],'published');m=first['manifest']
        self.assertEqual(first['pending_bytes'],m['bytes'])
        self.assertEqual(first['oldest_pending_ms'],m['created_at_ms'])
        with sqlite3.connect(self.db) as db:db.execute('INSERT INTO events VALUES("second")')
        again=self.runjob(1800000000000+3*86400000)
        self.assertEqual(again['state'],'waiting_for_nas');self.assertEqual(len(self.spool.list()),1)
        self.assertEqual(again['oldest_pending_ms'],m['created_at_ms']);self.assertIsNone(again['last_offsite_backup_ms'])
    def test_daily_due_preserves_previous_until_new_acked_then_keeps_one(self):
        first=self.runjob()['manifest'];self.ack(first)
        self.assertEqual(self.runjob(1800000000000+1000)['state'],'not_due')
        second=self.runjob(1800000000000+86400000)['manifest']
        self.assertEqual(len(self.spool.list()),2)
        self.ack(second);status=self.runjob(1800000000000+86401000)
        self.assertEqual(status['state'],'not_due');self.assertEqual([m['archive_id'] for m in self.spool.list()],[second['archive_id']])
        self.assertEqual(status['last_offsite_backup_ms'],second['created_at_ms'])
        self.assertEqual(self.spool.manifest(first['archive_id']),first,'old manifest serves lost-ACK recovery after payload GC')
        self.assertEqual(self.ack(first)['archive_id'],first['archive_id'])
    def test_crash_after_backup_reuses_snapshot_and_manifest_without_recapture(self):
        real=self.spool.publish_prepared
        with patch.object(self.job.archive.Spool,'publish_prepared',side_effect=RuntimeError('process interrupted')):
            with self.assertRaises(RuntimeError):self.runjob()
        with sqlite3.connect(self.db) as db:db.execute('INSERT INTO events VALUES("after-crash")')
        result=self.runjob();self.assertEqual(result['manifest']['source_range']['tables']['events'],1)
    def test_retry_after_rename_repeats_durability_before_finishing(self):
        original=self.job.archive.sync_dir
        failed=[False]
        def fail_once(path):
            if path.name=='published' and list(path.iterdir()) and not failed[0]:
                failed[0]=True;raise OSError('fsync interrupted')
            return original(path)
        with patch.object(self.job.archive,'sync_dir',side_effect=fail_once):
            with self.assertRaises(OSError):self.runjob()
        self.assertTrue((self.root/'spool/backup-work/ready.json').exists())
        called=[]
        with patch.object(self.job.archive,'sync_dir',side_effect=lambda p:(called.append(p.name),original(p))[1]):self.runjob()
        self.assertIn('published',called,'retry must repeat durable publication barrier')
    def test_recovery_drops_only_own_incomplete_build_and_never_last_complete(self):
        m=self.runjob()['manifest'];self.ack(m)
        build=self.root/'spool'/'backup-work';build.mkdir(exist_ok=True);(build/'snapshot.partial').write_bytes(b'interrupted')
        self.runjob(1800000000000+86400000)
        self.assertEqual(len(self.spool.list()),2)
        self.assertTrue(self.spool.package(m['archive_id']).exists())
    def test_spool_other_kind_is_never_pruned_and_low_space_does_not_touch_source(self):
        small=self.root/'ark';small.write_bytes(b'{}');ark=self.spool.publish(small,'ark_checkpoint',1,{})
        m=self.runjob()['manifest'];self.ack(m)
        with patch.object(self.job.shutil,'disk_usage',return_value=(10,9,1)):
            with self.assertRaisesRegex(ValueError,'SPACE'):self.runjob(1800000000000+86400000)
        self.assertTrue(self.spool.package(m['archive_id']).exists());self.assertTrue(self.spool.package(ark['archive_id']).exists())

if __name__=='__main__':unittest.main()
