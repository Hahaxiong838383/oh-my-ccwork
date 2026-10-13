import hashlib,importlib.util,json,tarfile,tempfile,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('rollback',Path(__file__).with_name('analytics-rollback.py'))
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)

class RollbackTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()/'server';self.root.mkdir();mod.SERVER=self.root
  self.snapshot=self.root/'backups/analytics-releases/analytics-predeploy-test';self.snapshot.mkdir(parents=True)
  self.target=self.root/'src/config-store.ts';self.target.parent.mkdir();self.target.write_bytes(b'new code')
  self.database=self.root/'data/analytics.db';self.database.parent.mkdir();self.database.write_bytes(b'accepted/seen must remain')
  original=self.snapshot/'old.ts';original.write_bytes(b'old code')
  self.archive=self.snapshot/'source-only.tar.gz'
  with tarfile.open(self.archive,'w:gz') as tar:tar.add(original,arcname=str(self.target).lstrip('/'))
  self.manifest={'source_archive_sha256':mod.digest(self.archive.read_bytes()),'files':{str(self.target):mod.digest(b'old code'),str(self.database):mod.digest(b'older database')}}
  (self.snapshot/'manifest.json').write_text(json.dumps(self.manifest))
  self.release=self.snapshot/'release.json';self.release.write_text(json.dumps({'files':{str(self.target):mod.digest(b'new code'),str(self.database):mod.digest(self.database.read_bytes())}}))
 def tearDown(self):self.temp.cleanup()
 def test_restore_selects_only_owned_code_and_preserves_database(self):
  items=mod.plan_restore(self.snapshot,self.release);self.assertEqual(len(items),1)
  for path,data,mode in items:mod.atomic_write(path,data,mode)
  self.assertEqual(self.target.read_bytes(),b'old code');self.assertEqual(self.database.read_bytes(),b'accepted/seen must remain')
 def test_later_edit_and_archive_tampering_abort_before_write(self):
  self.target.write_bytes(b'later colleague edit')
  with self.assertRaises(ValueError):mod.plan_restore(self.snapshot,self.release)
  self.assertEqual(self.target.read_bytes(),b'later colleague edit')
  self.target.write_bytes(b'new code');self.archive.write_bytes(b'tampered')
  with self.assertRaises(ValueError):mod.plan_restore(self.snapshot,self.release)
  self.assertEqual(self.target.read_bytes(),b'new code')

if __name__=='__main__':unittest.main()
