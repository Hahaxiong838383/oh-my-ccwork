import importlib.util,tempfile,os,unittest,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('control',Path(__file__).with_name('analytics-control.py')); control=importlib.util.module_from_spec(spec); spec.loader.exec_module(control)
class ControlTests(unittest.TestCase):
 def test_hot_disable_atomic_private_json(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'analytics-control.json'; control.set_enabled(p,True); control.set_enabled(p,False)
   self.assertEqual(json.loads(p.read_text()),{'enabled':False}); self.assertEqual(p.stat().st_mode & 0o777,0o600); self.assertEqual(list(Path(d).glob('*.tmp')),[])
 def test_symlink_target_is_rejected_without_changing_target(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d); p=r/'target'; p.write_text('protected'); link=r/'control'; link.symlink_to(p)
   with self.assertRaises(ValueError): control.set_enabled(link,False)
   self.assertEqual(p.read_text(),'protected')
if __name__=='__main__': unittest.main()
