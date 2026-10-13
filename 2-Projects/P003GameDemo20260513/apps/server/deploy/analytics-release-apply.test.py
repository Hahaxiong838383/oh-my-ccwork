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
 def make_bundle(self,source_data=b'release',commit='test',baseline='baseline'):
  with tarfile.open(self.bundle,'w:gz') as t:
   for name,data in [('source.ts',source_data),('release.json',json.dumps({'commit':commit,'baseline':baseline,'entries':self.entries}).encode())]:
    member=tarfile.TarInfo(name);member.size=len(data);t.addfile(member,io.BytesIO(data))
 def call(self,apply=False,release_id=None):
  prior=sys.argv;sys.argv=['release','--bundle',str(self.bundle)]+(['--apply'] if apply else [])+(['--release-id',release_id] if release_id is not None else [])
  try:
   with contextlib.redirect_stdout(io.StringIO()) as output:mod.main()
   return json.loads(output.getvalue())
  finally:sys.argv=prior
 def tearDown(self):self.temp.cleanup()
 def apply_release(self,release_id):
  try:return self.call(True,release_id)
  except SystemExit:self.fail('a valid release-id must be accepted by the CLI')
 def test_verify_then_apply_without_unrelated_state_change(self):
  self.assertFalse(self.call()['mutated']);self.assertEqual(self.source.read_bytes(),b'baseline')
  self.assertEqual(self.call(True)['installed_files'],1);self.assertEqual(self.source.read_bytes(),b'release');self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
 def test_two_releases_keep_independent_complete_manifests(self):
  first=Path(self.call(True)['manifest_path']);prior=first.read_bytes()
  self.assertEqual(first,mod.SERVER/'backups/analytics-releases/analytics-release-20261013/manifest.json')
  self.entries[0]['sha256']=mod.digest(b'capacity release');self.entries[0]['expected_current_sha256']=mod.digest(b'release')
  self.make_bundle(b'capacity release','capacity-commit','test')
  second=Path(self.apply_release('analytics-release-capacity-20261013T134500Z')['manifest_path'])
  self.assertEqual(second,mod.SERVER/'backups/analytics-releases/analytics-release-capacity-20261013T134500Z/manifest.json')
  self.assertEqual(first.read_bytes(),prior);self.assertEqual(json.loads(second.read_text())['files'],{str(self.source):hashlib.sha256(b'capacity release').hexdigest()})
  self.assertEqual(self.source.read_bytes(),b'capacity release');self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
 def test_same_bundle_and_release_id_can_be_applied_twice(self):
  release_id='analytics-release-20261013-capacity-2';first=self.apply_release(release_id);manifest=Path(first['manifest_path']);prior=manifest.read_bytes()
  self.assertEqual(self.apply_release(release_id)['manifest_path'],str(manifest));self.assertEqual(manifest.read_bytes(),prior)
  self.assertEqual(self.source.read_bytes(),b'release');self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
 def test_invalid_release_ids_are_rejected_without_target_writes(self):
  values=['','../analytics-release-20261013','/tmp/analytics-release-20261013','analytics-release-20261013/../../outside','analytics-release-20261013..','analytics-release-20261013\\outside','analytics-release-no-date','analytics-release-20261013\n','analytics-release-20261013-闯入','analytics-release-20261013-'+'x'*120]
  for value in values:
   with self.subTest(release_id=value),contextlib.redirect_stderr(io.StringIO()):
    with self.assertRaises(SystemExit):self.call(True,value)
    self.assertEqual(self.source.read_bytes(),b'baseline');self.assertFalse((mod.SERVER/'backups').exists())
 def assert_different_package_rejected(self,release_id):
  manifest=Path(self.call(True,release_id)['manifest_path']);prior=manifest.read_bytes();identity=self.source.stat().st_ino
  self.entries[0]['sha256']=mod.digest(b'capacity release');self.entries[0]['expected_current_sha256']=mod.digest(b'release');self.make_bundle(b'capacity release','capacity-commit','test')
  for apply in [False,True]:
   with self.subTest(apply=apply):
    with self.assertRaisesRegex(ValueError,'different bundle'):self.call(apply,release_id)
    self.assertEqual(manifest.read_bytes(),prior);self.assertEqual(self.source.read_bytes(),b'release');self.assertEqual(self.source.stat().st_ino,identity)
    self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
 def test_default_release_id_rejects_a_different_package_before_writing(self):self.assert_different_package_rejected(None)
 def test_named_release_id_rejects_a_different_package_before_writing(self):self.assert_different_package_rejected('analytics-release-capacity-20261013T140000Z')
 def test_same_sources_in_a_different_archive_cannot_reuse_release_id(self):
  release_id='analytics-release-capacity-20261013-repacked';manifest=Path(self.apply_release(release_id)['manifest_path']);prior=manifest.read_bytes();identity=self.source.stat().st_ino
  # A different gzip timestamp changes package identity without changing its sources.
  repacked=bytearray(self.bundle.read_bytes());repacked[4]^=1;self.bundle.write_bytes(repacked)
  with self.assertRaisesRegex(ValueError,'different bundle'):self.call(True,release_id)
  self.assertEqual(manifest.read_bytes(),prior);self.assertEqual(self.source.stat().st_ino,identity)
 def test_manifest_has_identity_of_the_verified_archive(self):
  result=self.call(True);receipt=json.loads(Path(result['manifest_path']).read_text())
  self.assertEqual(receipt.get('bundle_sha256'),hashlib.sha256(self.bundle.read_bytes()).hexdigest())
 def test_manifest_created_during_staging_blocks_target_replacement(self):
  release_id='analytics-release-capacity-20261013-raced';manifest=mod.SERVER/'backups/analytics-releases'/release_id/'manifest.json';original=mod.tempfile.mkstemp;identity=self.source.stat().st_ino
  def collided(*args,**kwargs):
   manifest.parent.mkdir(parents=True,exist_ok=True);manifest.write_bytes(b'colleague manifest');return original(*args,**kwargs)
  with patch.object(mod.tempfile,'mkstemp',side_effect=collided):
   with self.assertRaises(ValueError):self.call(True,release_id)
  self.assertEqual(self.source.read_bytes(),b'baseline');self.assertEqual(self.source.stat().st_ino,identity);self.assertEqual(manifest.read_bytes(),b'colleague manifest')
 def test_release_directory_symlink_is_rejected_before_writing(self):
  release_id='analytics-release-capacity-20261013-link';release=mod.SERVER/'backups/analytics-releases'/release_id;outside=self.root/'outside';outside.mkdir();release.parent.mkdir(parents=True);release.symlink_to(outside,target_is_directory=True)
  with self.assertRaises(ValueError):self.call(True,release_id)
  self.assertEqual(self.source.read_bytes(),b'baseline');self.assertEqual(list(outside.iterdir()),[])
 def test_later_change_blocks_entire_release(self):
  self.source.write_bytes(b'colleague change')
  with self.assertRaises(ValueError):self.call(True)
  self.assertEqual(self.source.read_bytes(),b'colleague change');self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state')
 def test_env_not_in_source_release(self):
  self.entries[0]['target']=str(mod.SERVER/'.env.local');self.make_bundle()
  with self.assertRaises(ValueError):self.call(True)
  self.assertEqual(self.source.read_bytes(),b'baseline')
 def test_target_traversal_cannot_write_database_outside_source_allowlist(self):
  self.entries[0]['target']=str(mod.SERVER/'src/../data/devices.db');self.entries[0]['expected_current_sha256']=mod.digest(b'live unrelated state');self.make_bundle()
  with self.assertRaises(ValueError):self.call(True)
  self.assertEqual(self.unrelated.read_bytes(),b'live unrelated state');self.assertEqual(self.source.read_bytes(),b'baseline')
 def test_legacy_manifest_without_bundle_identity_is_preserved(self):
  manifest=Path(self.call(True)['manifest_path']);receipt=json.loads(manifest.read_text());receipt.pop('bundle_sha256');receipt.pop('release_id');manifest.write_text(json.dumps(receipt));prior=manifest.read_bytes();identity=self.source.stat().st_ino
  with self.assertRaisesRegex(ValueError,'different bundle'):self.call(True)
  self.assertEqual(manifest.read_bytes(),prior);self.assertEqual(self.source.stat().st_ino,identity)
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
