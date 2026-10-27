import contextlib,hashlib,importlib.util,io,json,pathlib,sys,tempfile,unittest
from unittest import mock
source=(pathlib.Path(sys.argv.pop(1)) if __name__ == '__main__' and len(sys.argv) > 1 and not sys.argv[1].startswith('-') else pathlib.Path(__file__).with_name('rule-updater.py'))
spec=importlib.util.spec_from_file_location('updater',source)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Cases(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.base=pathlib.Path(self.tmp.name)/'xray';self.base.mkdir()
  for n in ['geosite.dat','geoip.dat']:(self.base/n).write_bytes(b'old')
  (self.base/'config.json').write_text('{"routing":{"rules":[]}}')
  self.patch=mock.patch.object(m,'XRAY_HOME',self.base);self.patch.start();self.addCleanup(self.patch.stop)
 def managed(self,plist=False):
  if plist:p=self.base.parent/'Library/LaunchAgents/com.company.lisa-failover.plist'
  else:p=self.base/'company-lisa-failover/controller.json'
  p.parent.mkdir(parents=True,exist_ok=True);p.write_text('invalid still installed')
 def seed(self):
  p=self.base/'rule-updater.pending.json'
  p.write_text(json.dumps({'version':1,'status':'pending_until_verified','first_pending_at':'previous','asset_sha256':{'geosite.dat':hashlib.sha256(b'old').hexdigest()},'xray_pid_before':123}))
  return p,p.read_bytes()
 def run_update(self,changed=True,pids=None,fail=False):
  def download(url,p):
   if fail:return 0
   p.write_bytes(b'new' if changed else b'old');return p.stat().st_size
  buf=io.StringIO()
  with mock.patch.object(m,'download_to_tmp',side_effect=download),mock.patch.object(m,'get_xray_pid',side_effect=pids or [123,124]),mock.patch.object(m.os,'kill') as kill,mock.patch.object(m.time,'sleep'),contextlib.redirect_stdout(buf):
   try:m.main()
   except SystemExit as e:self.assertEqual(e.code,0)
  return json.loads((self.base/'rule-updater.status').read_text()),kill.call_args_list,buf.getvalue()
 def test_managed_updates_disk_without_signal(self):
  self.managed();state,calls,_=self.run_update()
  self.assertEqual(calls,[])
  self.assertEqual((self.base/'geosite.dat').read_bytes(),b'new')
  self.assertEqual((self.base/'geoip.dat').read_bytes(),b'new')
  self.assertEqual(state.get('status'),'pending_restart')
  self.assertFalse(state.get('applied'))
  pending=json.loads((self.base/'rule-updater.pending.json').read_text())
  self.assertEqual(pending['status'],'pending_until_verified')
  self.assertEqual(pending['asset_sha256'],{n:hashlib.sha256(b'new').hexdigest() for n in ['geoip.dat','geosite.dat']})
 def test_pending_not_erased_by_next_noop_run(self):
  self.managed();p,old=self.seed();state,calls,_=self.run_update(changed=False)
  self.assertEqual(state.get('status'),'pending_restart');self.assertTrue(state.get('pending_restart'))
  self.assertEqual(p.read_bytes(),old);self.assertEqual(calls,[])
 def test_changed_pid_does_not_falsely_prove_application(self):
  self.managed();p,old=self.seed();state,calls,_=self.run_update(changed=False,pids=[999,1000])
  self.assertEqual(state.get('reload_status'),'pending_until_verified');self.assertFalse(state.get('applied'))
  self.assertEqual(p.read_bytes(),old)
 def test_managed_noop_without_pending_remains_ok(self):
  self.managed();state,calls,_=self.run_update(changed=False)
  self.assertEqual(state['status'],'ok');self.assertEqual(calls,[])
  self.assertFalse((self.base/'rule-updater.pending.json').exists())
 def test_plist_only_installation_still_suppresses_signal(self):
  self.managed(plist=True);state,calls,_=self.run_update()
  self.assertEqual(calls,[]);self.assertEqual(state.get('status'),'pending_restart')
 def test_legacy_update_retains_signal_behavior(self):
  state,calls,_=self.run_update()
  self.assertEqual(len(calls),1);self.assertEqual(calls[0].args,(123,m.signal.SIGHUP))
  self.assertEqual(state['status'],'ok');self.assertEqual(state['xray_pid_after'],124)
 def test_legacy_noop_still_does_not_signal(self):
  state,calls,_=self.run_update(changed=False)
  self.assertEqual(state['status'],'ok');self.assertEqual(calls,[])
 def test_download_error_keeps_pending(self):
  self.managed();p,old=self.seed();state,calls,_=self.run_update(fail=True)
  self.assertEqual(state['status'],'partial');self.assertTrue(state.get('pending_restart'));self.assertEqual(p.read_bytes(),old)
  self.assertEqual(calls,[])
 def test_missing_process_does_not_erase_pending(self):
  self.managed();p,old=self.seed();state,calls,_=self.run_update(pids=[None])
  self.assertEqual(state.get('status'),'pending_restart');self.assertEqual(p.read_bytes(),old);self.assertEqual(calls,[])
 def test_corrupt_pending_marker_stays_pending(self):
  self.managed();p=self.base/'rule-updater.pending.json';p.write_text('not-json')
  state,calls,_=self.run_update(changed=False)
  self.assertEqual(state.get('status'),'pending_restart');self.assertEqual(state.get('reload_status'),'pending_until_verified')
  self.assertEqual(p.read_text(),'not-json');self.assertEqual(calls,[])
 def test_pending_marker_must_commit_before_resource_replacement(self):
  self.managed();original=m.os.replace
  def replace(src,dst):
   if pathlib.Path(dst).name=='rule-updater.pending.json':raise PermissionError('marker denied')
   return original(src,dst)
  with mock.patch.object(m.os,'replace',side_effect=replace):state,calls,_=self.run_update()
  self.assertEqual((self.base/'geosite.dat').read_bytes(),b'old')
  self.assertEqual((self.base/'geoip.dat').read_bytes(),b'old')
  self.assertEqual(state['status'],'partial');self.assertEqual(calls,[])
 def test_rotation_is_retained(self):
  self.managed();(self.base/'access.log').write_text('log-data')
  with mock.patch.object(m,'LOG_MAX_MB',0):self.run_update(changed=False)
  self.assertEqual((self.base/'access.log.1').read_text(),'log-data')

 def test_managed_active_logs_keep_inode_and_writer_across_rotations(self):
  self.managed()
  for name in ['access.log','xray.log']:
   with self.subTest(name=name):
    path=self.base/name;path.write_bytes(b'old-data')
    inode=path.stat().st_ino
    with path.open('ab',buffering=0) as writer,mock.patch.object(m,'LOG_MAX_MB',0):
     self.run_update(changed=False)
     self.assertTrue(path.exists());self.assertEqual(path.stat().st_ino,inode)
     self.assertEqual(path.read_bytes(),b'');self.assertEqual((self.base/(name+'.1')).read_bytes(),b'old-data')
     writer.write(b'new-data');self.assertEqual(path.read_bytes(),b'new-data')
     self.run_update(changed=False)
     self.assertEqual(path.stat().st_ino,inode);self.assertEqual(path.read_bytes(),b'')
     self.assertEqual((self.base/(name+'.1')).read_bytes(),b'new-data')
     writer.write(b'after-second');self.assertEqual(path.read_bytes(),b'after-second')
 def test_managed_updater_log_retains_rename(self):
  self.managed();path=self.base/'rule-updater.log';path.write_text('updater-data')
  inode=path.stat().st_ino
  with mock.patch.object(m,'LOG_MAX_MB',0):self.run_update(changed=False)
  self.assertFalse(path.exists());self.assertEqual((self.base/'rule-updater.log.1').stat().st_ino,inode)
 def test_unmanaged_active_log_retains_rename(self):
  path=self.base/'access.log';path.write_text('legacy-data');inode=path.stat().st_ino
  with mock.patch.object(m,'LOG_MAX_MB',0):self.run_update(changed=False)
  self.assertFalse(path.exists());self.assertEqual((self.base/'access.log.1').stat().st_ino,inode)
 def test_managed_failed_backup_does_not_truncate(self):
  self.managed();path=self.base/'access.log';path.write_bytes(b'must-stay')
  with mock.patch.object(m,'LOG_MAX_MB',0),mock.patch.object(m.os,'replace',side_effect=OSError('backup denied')):
   with self.assertRaises(OSError):m.rotate_log('access.log',copytruncate=True)
  self.assertEqual(path.read_bytes(),b'must-stay')

if __name__=='__main__':unittest.main()
