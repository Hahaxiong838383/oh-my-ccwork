import importlib.util,json,os,sqlite3,subprocess,tempfile,unittest,threading,time,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
class ExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.db=self.root/'ark.db';self.spool=self.root/'spool'
        self.assertTrue((HERE/'storage-ark-export.py').exists(),'T3 reliable exporter missing')
        self.m=load('ark_export',HERE/'storage-ark-export.py')
        code="""import {ArkStore} from './src/ark/store.ts';import {readFileSync} from 'node:fs';
const s=new ArkStore(process.argv[1],undefined,()=>({enabled:true,limitBytes:1e9,reserveBytes:0,freeBytes:1e12}));
const i={sn:'BJP00399999999999901',account_id:'synthetic-device',epoch:1},now=1794830000000;s.authorize(i,now);
const f=JSON.parse(readFileSync('../../docs/ark-brain-20261031/snapshot-v1.example.json','utf8'));
for(let n=1;n<=Number(process.argv[2]);n++)s.accept(i,{...f,snapshot_id:'s-'+n,boot_started_at_ms:now-1,captured_at_ms:now+n,sequence:n,wallets:{family_coin:n,stardust:null}},now+n);s.close();"""
        subprocess.run([os.environ.get('TEST_NODE','/Users/fu-121/.local/node-v24/bin/node'),'--experimental-sqlite','--import','tsx','--input-type=module','-e',code,str(self.db),'3'],cwd=HERE.parent,check=True,capture_output=True)
    def tearDown(self):self.tmp.cleanup()
    def sql(self,q):
        with sqlite3.connect(self.db) as db:return db.execute(q).fetchall()
    def cycle(self):return self.m.cycle(self.db,self.spool)
    def manifest(self):return self.m.Spool(self.spool).list()[0]
    def ack(self,m):return self.m.Spool(self.spool).ack(m['archive_id'],m['sha256'],m['bytes'],m['record_count'])
    def test_publish_retry_ack_and_cleanup(self):
        self.cycle();m=self.manifest();self.assertEqual(m['record_count'],3);self.cycle();self.assertEqual(self.manifest(),m)
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],3)
        self.ack(m);self.cycle();self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],0)
        self.assertFalse((self.spool/'published'/m['archive_id']/'payload.bin').exists());self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_baseline')[0][0],1)
        self.cycle();self.assertEqual(self.sql('SELECT pending_records,reserved_bytes FROM ark_archive_stats'),[(0,0)])
    def test_wrong_ack_never_clears(self):
        self.cycle();m=self.manifest();p=self.spool/'receipts'/(m['archive_id']+'.json');p.write_text(json.dumps({**m,'record_count':4,'verified_at_ms':1}))
        with self.assertRaises(ValueError):self.cycle()
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],3)
    def test_interrupted_publish_reuses_persisted_id_and_manifest(self):
        original=self.m.Spool.publish_prepared
        self.m.Spool.publish_prepared=lambda *a,**k:(_ for _ in ()).throw(RuntimeError('crash_before_publish'))
        try:
            with self.assertRaises(RuntimeError):self.cycle()
        finally:self.m.Spool.publish_prepared=original
        before=self.sql('SELECT archive_id,manifest FROM ark_archive_batch')[0];self.cycle();self.assertEqual(self.manifest()['archive_id'],before[0]);self.assertEqual(json.loads(before[1]),self.manifest())
    def test_ack_then_cleanup_failure_can_resume(self):
        self.cycle();m=self.manifest();self.ack(m);original=self.m.clean_payload
        self.m.clean_payload=lambda *a:(_ for _ in ()).throw(RuntimeError('cleanup_crash'))
        try:
            with self.assertRaises(RuntimeError):self.cycle()
        finally:self.m.clean_payload=original
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],3);self.cycle();self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],0)
    def test_mapping_tamper_cannot_confirm_or_delete(self):
        self.cycle();m=self.manifest();self.ack(m)
        with sqlite3.connect(self.db) as db:db.execute('UPDATE ark_archive_outbox SET envelope=? WHERE id=1',('{}',))
        with self.assertRaises(ValueError):self.cycle()
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],3)
    def test_ack_race_after_validation_keeps_rows_and_does_not_mark_complete(self):
        self.cycle();m=self.manifest();self.ack(m)
        clean=self.m.clean_payload
        def mutate_after_validation(*a):
            clean(*a)
            with sqlite3.connect(self.db) as db:db.execute('UPDATE ark_archive_outbox SET envelope=? WHERE id=1',('{}',))
        self.m.clean_payload=mutate_after_validation
        with self.assertRaisesRegex(ValueError,'archive_mapping_changed'):self.cycle()
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],3)
        self.assertNotEqual(self.sql('SELECT state FROM ark_archive_batch')[0][0],'complete')
    def test_claim_reads_before_write_lock_and_leaves_concurrent_append_for_next_batch(self):
        # The device may append while the exporter selects its bounded prefix.
        # Read/page waits must not hold the write lock needed by that device.
        with sqlite3.connect(self.db,isolation_level=None) as raw:
            raw.row_factory=sqlite3.Row
            class ConcurrentAppend:
                def __init__(self):self.appended=False
                def execute(inner,sql,args=()):
                    if sql.startswith('SELECT id,bytes FROM ark_archive_outbox'):
                        self.assertFalse(raw.in_transaction,'pending selection must not hold device write lock')
                        cursor=raw.execute(sql,args)
                        rows=cursor.fetchall()
                        with sqlite3.connect(self.db) as device:
                            device.execute('INSERT INTO ark_archive_outbox(grant_id,received_at_ms,envelope,bytes,reserved_bytes) SELECT grant_id,received_at_ms,envelope,bytes,reserved_bytes FROM ark_archive_outbox WHERE id=3')
                        inner.appended=True
                        class Rows:
                            def fetchall(self):return rows
                            def __iter__(self):return iter(rows)
                        return Rows()
                    return raw.execute(sql,args)
                def commit(inner):return raw.commit()
                def rollback(inner):return raw.rollback()
            connection=ConcurrentAppend();aid=self.m.claim(connection,1)
            self.assertTrue(connection.appended)
            self.assertEqual(raw.execute('SELECT record_count,first_id,last_id FROM ark_archive_batch WHERE archive_id=?',(aid,)).fetchone()[:],(3,1,3))
            self.assertEqual(raw.execute('SELECT batch_id FROM ark_archive_outbox WHERE id=4').fetchone()[0],None)
    def test_claim_preserves_byte_limit_and_skips_already_claimed_gap(self):
        with sqlite3.connect(self.db,isolation_level=None) as db:
            db.row_factory=sqlite3.Row
            db.execute("UPDATE ark_archive_outbox SET batch_id='older' WHERE id=2")
            size=db.execute('SELECT bytes FROM ark_archive_outbox WHERE id=1').fetchone()[0]
            from unittest.mock import patch
            with patch.object(self.m,'MAX_BYTES',size):aid=self.m.claim(db,1)
            self.assertEqual(db.execute('SELECT record_count,first_id,last_id FROM ark_archive_batch WHERE archive_id=?',(aid,)).fetchone()[:],(1,1,1))
            self.assertEqual(db.execute('SELECT batch_id FROM ark_archive_outbox WHERE id=2').fetchone()[0],'older')
            self.assertIsNone(db.execute('SELECT batch_id FROM ark_archive_outbox WHERE id=3').fetchone()[0])
    def test_claim_changed_prefix_rolls_back_batch_and_all_mappings(self):
        with sqlite3.connect(self.db,isolation_level=None) as raw:
            raw.row_factory=sqlite3.Row
            class ChangedPrefix:
                def execute(inner,sql,args=()):
                    if sql=='BEGIN IMMEDIATE':
                        with sqlite3.connect(self.db) as other:
                            other.execute('UPDATE ark_archive_outbox SET bytes=bytes+1 WHERE id=2')
                    return raw.execute(sql,args)
                def commit(inner):return raw.commit()
                def rollback(inner):return raw.rollback()
            with self.assertRaisesRegex(ValueError,'archive_claim_changed'):self.m.claim(ChangedPrefix(),1)
            self.assertEqual(raw.execute('SELECT count(*) FROM ark_archive_batch').fetchone()[0],0)
            self.assertEqual(raw.execute('SELECT count(*) FROM ark_archive_outbox WHERE batch_id IS NULL').fetchone()[0],3)
    def test_parallel_job_lock_refuses(self):
        import fcntl
        self.spool.mkdir();f=(self.spool/'.ark-export.lock').open('w');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            with self.assertRaises(BlockingIOError):self.cycle()
        finally:f.close()
    def hold_writer(self,release):
        self.m.Spool(self.spool)  # Finish filesystem bootstrap before timing the DB lock.
        held=threading.Event()
        def writer():
            with sqlite3.connect(self.db,isolation_level=None) as db:
                db.execute('BEGIN IMMEDIATE');held.set();release.wait(3);db.rollback()
        thread=threading.Thread(target=writer);thread.start();self.assertTrue(held.wait(2));return thread
    @unittest.skipUnless(sys.platform=='linux','real SQLite busy deadlines require the Linux deployment runtime')
    def test_transient_writer_lock_exports_once_without_lengthening_sqlite_timeout(self):
        from unittest.mock import patch
        release=threading.Event();thread=self.hold_writer(release);original=sqlite3.connect;timing=[];timers=[]
        def connect(*a,**k):
            db=original(*a,**k);timing.append(time.monotonic());timer=threading.Timer(.35,release.set);timers.append(timer);timer.start();return db
        try:
            with patch.object(self.m.sqlite3,'connect',connect):result=self.cycle()
        finally:release.set();thread.join();[timer.cancel() for timer in timers]
        self.assertGreaterEqual(time.monotonic()-timing[0],.3);self.assertLess(time.monotonic()-timing[0],1.5)
        self.assertGreater(result['busy_retries'],0);self.assertEqual(result['sqlite_busy_timeout_ms'],100)
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_batch'),[(1,)])
        m=self.manifest();self.assertEqual(m['record_count'],3);self.ack(m);self.cycle()
        self.assertEqual(self.sql('SELECT pending_records,reserved_bytes FROM ark_archive_stats'),[(0,0)])
    @unittest.skipUnless(sys.platform=='linux','real SQLite busy deadlines require the Linux deployment runtime')
    def test_persistent_writer_lock_stops_bounded_and_preserves_pending(self):
        release=threading.Event();thread=self.hold_writer(release);start=time.monotonic()
        try:
            with self.assertRaises(sqlite3.OperationalError) as caught:self.cycle()
            self.assertEqual(caught.exception.sqlite_errorcode&255,sqlite3.SQLITE_BUSY)
            self.assertLess(time.monotonic()-start,1.5)
        finally:release.set();thread.join()
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox'),[(3,)])
        self.assertEqual(self.m.Spool(self.spool).list(),[])
        self.cycle();self.assertEqual(self.manifest()['record_count'],3)
    def test_non_busy_sqlite_error_is_not_retried(self):
        with self.m.ExportConnection(':memory:',isolation_level=None) as db:
            with self.assertRaises(sqlite3.OperationalError) as caught:db.execute('SELECT * FROM missing_table')
            self.assertEqual(caught.exception.sqlite_errorcode,sqlite3.SQLITE_ERROR)
            self.assertEqual(db.busy_retries,0)
    def test_disk_consumed_after_accept_pauses_export_without_losing_rows(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        with patch.object(self.m.shutil,'disk_usage',return_value=SimpleNamespace(free=1)):
            with self.assertRaisesRegex(ValueError,'archive_export_disk_reserve'):self.cycle()
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],3)
        self.assertEqual(self.m.Spool(self.spool).list(),[])
        self.cycle();m=self.manifest();self.ack(m)
        with patch.object(self.m.shutil,'disk_usage',return_value=SimpleNamespace(free=1)):
            self.cycle()  # Verified cleanup must still release space when disk is low.
        self.assertEqual(self.sql('SELECT pending_records,reserved_bytes FROM ark_archive_stats'),[(0,0)])
    def test_low_disk_unpublished_batch_does_not_block_later_verified_cleanup(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        spool=self.m.Spool(self.spool);work=self.spool/'ark-work';work.mkdir()
        with sqlite3.connect(self.db,isolation_level=None) as db:
            db.row_factory=sqlite3.Row
            with patch.object(self.m,'MAX_ROWS',1):
                first=self.m.claim(db,1);later=self.m.claim(db,2)
            self.m.process_batch(db,spool,work,later)
        self.ack(self.manifest())
        with patch.object(self.m.shutil,'disk_usage',return_value=SimpleNamespace(free=1)):
            with self.assertRaisesRegex(ValueError,'archive_export_disk_reserve'):self.cycle()
        self.assertEqual(self.sql("SELECT state FROM ark_archive_batch WHERE archive_id='"+later+"'"),[('complete',)])
        self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox'),[(2,)])
        self.cycle();self.assertEqual(len(self.m.Spool(self.spool).list()),2)
    def test_real_sigkill_publish_and_directory_rename_recovers_same_batch(self):
        import sys
        code="""import sys,os,signal,importlib.util
from pathlib import Path
p=Path(sys.argv[1]);s=importlib.util.spec_from_file_location('exporter',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
orig=m.Spool.publish_prepared
def kill_after(self,*a,**k):
    result=orig(self,*a,**k);os.kill(os.getpid(),signal.SIGKILL)
m.Spool.publish_prepared=kill_after
m.cycle(Path(sys.argv[2]),Path(sys.argv[3]))
"""
        r=subprocess.run([sys.executable,'-c',code,str(HERE/'storage-ark-export.py'),str(self.db),str(self.spool)],capture_output=True)
        self.assertEqual(r.returncode,-9,r.stderr);m=self.manifest();self.cycle();self.assertEqual(self.manifest(),m);self.ack(m);self.cycle();self.assertEqual(self.sql('SELECT count(*) FROM ark_archive_outbox')[0][0],0)
if __name__=='__main__':unittest.main()
