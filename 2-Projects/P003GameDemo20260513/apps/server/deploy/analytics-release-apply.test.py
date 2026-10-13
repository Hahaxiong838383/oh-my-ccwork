import contextlib,hashlib,importlib.util,io,json,sys,tarfile,tempfile,unittest
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
if __name__=='__main__':unittest.main()
