import contextlib,hashlib,importlib.util,io,json,sys,tarfile,tempfile,unittest
import os,stat
from unittest.mock import patch
from pathlib import Path

spec=importlib.util.spec_from_file_location('release',Path(__file__).with_name('analytics-release-apply.py'))
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class ReleaseTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();mod.SERVER=self.root/'server';mod.ADMIN=self.root/'web/admin/index.html'
  self.source=mod.SERVER/'src/config-store.ts';self.source.parent.mkdir(parents=True);self.source.write_bytes(b'baseline')
  self.unrelated=mod.SERVER/'data/devices.db';self.unrelated.parent.mkdir();self.unrelated.write_bytes(b'live unrelated state')
  self.bundle=self.root/'bundle.tar.gz'
  self.entries=[{'target':str(self.source),'member':'source.ts','sha256':mod.digest(b'release'),'expected_current_sha256':mod.digest(b'baseline')}]
  self.make_bundle()
 def make_bundle(self):
  with tarfile.open(self.bundle,'w:gz') as t:
   for name,data in [('source.ts',b'release'),('release.json',json.dumps({'commit':'test','baseline':'baseline','entries':self.entries}).encode())]:
    member=tarfile.TarInfo(name);member.size=len(data);t.addfile(member,io.BytesIO(data))
 def call(self,apply=False):
  prior=sys.argv;sys.argv=['release','--bundle',str(self.bundle)]+(['--apply'] if apply else [])
  try:
   with contextlib.redirect_stdout(io.StringIO()) as output:mod.main()
   return json.loads(output.getvalue())
  finally:sys.argv=prior
 def tearDown(self):self.temp.cleanup()
 def test_verify_then_apply_without_unrelated_state_change(self):
  self.assertFalse(self.call()['mutated']);self.assertEqual(self.source.read_bytes(),b'baseline')
  self.assertEqual(self.call(True)['installed_files'],1);self.assertEqual(self.source.read_bytes(),b'release');self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
 def test_later_change_blocks_entire_release(self):
  self.source.write_bytes(b'colleague change')
  with self.assertRaises(ValueError):self.call(True)
  self.assertEqual(self.source.read_bytes(),b'colleague change');self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
 def test_env_not_in_source_release(self):
  self.entries[0]['target']=str(mod.SERVER/'.env.local');self.make_bundle()
  with self.assertRaises(ValueError):self.call(True)
  self.assertEqual(self.source.read_bytes(),b'baseline')
 def test_edit_after_validation_before_replace_is_preserved(self):
  original=mod.tempfile.mkstemp
  def edited(*args,**kwargs):
   self.source.write_bytes(b'later colleague edit');return original(*args,**kwargs)
  with patch.object(mod.tempfile,'mkstemp',side_effect=edited):
   with self.assertRaises(ValueError):self.call(True)
  self.assertEqual(self.source.read_bytes(),b'later colleague edit');self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
 def test_same_bytes_replaced_identity_is_not_overwritten(self):
  original=mod.tempfile.mkstemp
  def swapped(*args,**kwargs):
   other=self.source.with_suffix('.other');other.write_bytes(b'baseline');other.replace(self.source);return original(*args,**kwargs)
  with patch.object(mod.tempfile,'mkstemp',side_effect=swapped):
   with self.assertRaises(ValueError):self.call(True)
  self.assertEqual(self.source.read_bytes(),b'baseline')
 def test_shared_lock_rejects_concurrent_deployment(self):
  lock=mod.SERVER/'.analytics-deploy.lock';lock.mkdir()
  with self.assertRaises(ValueError):self.call(True)
  self.assertTrue(lock.exists());self.assertEqual(self.source.read_bytes(),b'baseline')
 def test_manifest_and_source_are_fsynced_around_atomic_replace(self):
  events=[];sync=mod.os.fsync;replace=mod.os.replace
  def synced(fd):
   sync(fd);info=os.fstat(fd);events.append(('sync',info.st_ino,stat.S_ISDIR(info.st_mode)))
  def replaced(source,target):
   inode=Path(source).stat().st_ino;replace(source,target);events.append(('replace',str(target),inode))
  with patch.object(mod.os,'fsync',side_effect=synced),patch.object(mod.os,'replace',side_effect=replaced):result=self.call(True)
  manifest=Path(result['manifest_path']);self.assertEqual(manifest.stat().st_mode&0o777,0o600);self.assertEqual(json.loads(manifest.read_text())['commit'],'test')
  for target in [self.source,manifest]:
   replacement=events.index(('replace',str(target),target.stat().st_ino))
   self.assertIn(('sync',target.stat().st_ino,False),events,'文件必须在原子发布前fsync')
   self.assertLess(events.index(('sync',target.stat().st_ino,False)),replacement)
   self.assertTrue(any(item==('sync',target.parent.stat().st_ino,True) for item in events[replacement+1:]))
 def test_manifest_replace_failure_keeps_previous_complete_manifest_and_bundle(self):
  manifest=Path(self.call(True)['manifest_path']);prior=manifest.read_bytes();replace=mod.os.replace
  def failed(source,target):
   if Path(target)==manifest:raise OSError('test-only manifest replace failure')
   return replace(source,target)
  with patch.object(mod.os,'replace',side_effect=failed):
   with self.assertRaises(OSError):self.call(True)
  self.assertEqual(manifest.read_bytes(),prior);self.assertTrue(self.bundle.exists());self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
if __name__=='__main__':unittest.main()
