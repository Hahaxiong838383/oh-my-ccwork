import importlib.util,tempfile,unittest,builtins
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('publisher',Path(__file__).with_name('apply_hotwords.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Scope(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def proc(self,pid,group,cmd=b'/root/venv/python\0/root/eot_sidecar.py\0/socket\0'):
  d=self.root/str(pid);d.mkdir();(d/'cmdline').write_bytes(cmd)
  if group is not None:(d/'cgroup').write_text(group)
  return d
 def count(self):return m.sidecar_count(str(self.root))
 def test_only_owned_pool_counts(self):
  self.proc(1,'0::/system.slice/voice-worker-rust.service');self.proc(2,'0::/system.slice/p003-search-worker.service');self.proc(3,'0::/system.slice/p003-listening-worker.service');self.assertEqual(self.count(),1)
 def test_other_live_pools_do_not_prevent_completed_stop(self):
  self.proc(2,'0::/system.slice/p003-search-worker.service');self.proc(3,'0::/system.slice/p003-listening-worker.service');self.assertEqual(self.count(),0)
 def test_orphan_is_still_owned_until_cgroup_releases(self):
  d=self.proc(1,'0::/system.slice/voice-worker-rust.service');(d/'status').write_text('PPid:\t1\n');self.assertEqual(self.count(),1)
 def test_nested_owned_cgroup_counts(self):
  self.proc(1,'0::/custom.slice/voice-worker-rust.service/child');self.assertEqual(self.count(),1)
 def test_similarly_named_unit_is_not_owned(self):
  self.proc(1,'0::/system.slice/voice-worker-rust.service-extra');self.assertEqual(self.count(),0)
 def test_observer_text_is_not_sidecar(self):
  self.proc(1,'0::/system.slice/voice-worker-rust.service',b'python\0-c\0print("eot_sidecar.py")\0');self.assertEqual(self.count(),0)
 def test_disappeared_process_does_not_block(self):
  self.proc(1,None);self.assertEqual(self.count(),0)
 def test_unreadable_ownership_blocks(self):
  d=self.proc(1,'0::/system.slice/voice-worker-rust.service');original=builtins.open
  def read(p,*a,**kw):
   if str(p)==str(d/'cgroup'):raise PermissionError('denied')
   return original(p,*a,**kw)
  with patch('builtins.open',read):self.assertEqual(self.count(),1)
 def test_unreadable_process_inventory_blocks(self):
  with patch.object(m.os,'listdir',side_effect=PermissionError('denied')):self.assertEqual(self.count(),1)
 def test_malformed_ownership_blocks(self):
  self.proc(1,'invalid');self.assertEqual(self.count(),1)
 def test_cgroup_v1_owned_pool_counts_once(self):
  self.proc(1,'10:cpu:/system.slice/voice-worker-rust.service\n9:memory:/system.slice/voice-worker-rust.service');self.assertEqual(self.count(),1)
if __name__=='__main__':unittest.main(verbosity=2)
