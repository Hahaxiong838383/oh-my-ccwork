import importlib.util,json,os,sqlite3,subprocess,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).resolve().parent

class ProfileTest(unittest.TestCase):
    def test_real_export_timing_and_replay_without_bound_values(self):
        with tempfile.TemporaryDirectory(prefix='p003-t5-profile-') as temp:
            root=Path(temp).resolve();(root/'config.json').write_text('{"synthetic":true}')
            code="""import {ArkStore} from './src/ark/store.ts';import {readFileSync} from 'node:fs';
const s=new ArkStore(process.argv[1],undefined,()=>({enabled:true,limitBytes:1e9,reserveBytes:0,freeBytes:1e12}));
const i={sn:'BJP00399999999999901',account_id:'test-profile-private-value',epoch:1},now=1794830000000;s.authorize(i,now);
const f=JSON.parse(readFileSync('../../docs/ark-brain-20261031/snapshot-v1.example.json','utf8'));
for(let n=1;n<=3;n++)s.accept(i,{...f,snapshot_id:'s-'+n,boot_started_at_ms:now-1,captured_at_ms:now+n,sequence:n,wallets:{family_coin:n,stardust:null}},now+n);s.close();"""
            subprocess.run([os.environ.get('TEST_NODE','/Users/fu-121/.local/node-v24/bin/node'),'--import','tsx','--input-type=module','-e',code,str(root/'ark.db')],cwd=HERE.parent,check=True,capture_output=True)
            spec=importlib.util.spec_from_file_location('profile',HERE/'storage-ark-export-profile.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
            result=m.profile_cycle(root/'ark.db',root/'spool',root/'profile.json');self.assertEqual(result['published'],1)
            raw=(root/'profile.json').read_text();v=json.loads(raw);self.assertNotIn('test-profile-private-value',raw);self.assertNotIn('BJP003',raw)
            self.assertEqual(v['omitted'],0);self.assertTrue(v['flushed_after_cycle']);self.assertIsNone(v['error'])
            self.assertEqual(v['connections'][0]['wal_autocheckpoint'],1000)
            begins=[r for r in v['records']if r['verb']=='BEGIN'];commits=[r for r in v['records']if r['phase']=='commit']
            self.assertTrue(begins);self.assertEqual(len(begins),len(commits))
            for b,c in zip(begins,commits):
                self.assertFalse(b['before_transaction']);self.assertTrue(b['after_transaction']);self.assertTrue(c['before_transaction']);self.assertFalse(c['after_transaction']);self.assertGreaterEqual(c['started_at_ms'],b['finished_at_ms'])
            for r in v['records']:self.assertGreaterEqual(r['wall_ms'],0);self.assertGreaterEqual(r['finished_at_ms'],r['started_at_ms'])
            second=m.profile_cycle(root/'ark.db',root/'spool',root/'second.json');self.assertEqual(second['published'],1)
            db=sqlite3.connect(root/'ark.db')
            try:self.assertEqual(db.execute('SELECT count(*) FROM ark_archive_batch').fetchone()[0],1);self.assertEqual(db.execute('SELECT count(*) FROM ark_archive_outbox').fetchone()[0],3)
            finally:db.close()
            with self.assertRaises(ValueError):m.profile_cycle(root/'ark.db',root/'spool',root/'second.json')
            (root/'config.json').write_text('{"synthetic":false}')
            with self.assertRaises(ValueError):m.profile_cycle(root/'ark.db',root/'spool',root/'forbidden.json')
            self.assertFalse((root/'forbidden.json').exists())

if __name__=='__main__':unittest.main()
