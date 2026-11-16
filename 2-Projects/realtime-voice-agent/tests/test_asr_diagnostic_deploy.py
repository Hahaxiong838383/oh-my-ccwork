import contextlib, hashlib, importlib.util, io, json, pathlib, shutil, tempfile, unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).parents[1]/'scripts'
PATH=ROOT/'deploy_asr_diagnostics.py'
SNS=['BJP003261116999999%02d'%i for i in range(1,6)]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
class ReleaseSimulation(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.r=pathlib.Path(self.temp.name);self.d=self.r/'stage';self.d.mkdir();self.proc=self.r/'proc';self.proc.mkdir();self.clock=100000.;self.busy=False;self.inject=False;self.starts=0;self.stops=0;self.fail_start_number=None
  sp=importlib.util.spec_from_file_location('deploy_sim',PATH);self.m=importlib.util.module_from_spec(sp);sp.loader.exec_module(self.m);self.m.D=self.d
  shutil.copy2(ROOT/'asr_diagnostic_env.py',self.d/'asr_diagnostic_env.py');(self.d/'worker-candidate').write_bytes(b'reviewed-main')
  self.units={u:{'MainPID':str(100+i),'NRestarts':'0','ActiveState':'active'} for i,u in enumerate(['voice-worker-rust','p003-listening-worker','p003-search-worker'])};self.pools={}
  for pool,u in [('main','voice-worker-rust'),('listening','p003-listening-worker')]:
   root=self.r/pool;root.mkdir();b=root/'voice-rust-worker';b.write_bytes((pool+'-original').encode());e=root/'env';e.write_text('LLM_KEY=old-test-value\nLIVEKIT_URL=wss://test.invalid\nLIVEKIT_API_KEY=test-only\nLIVEKIT_API_SECRET=test-only\nP003_SEARCH_CANARY_HEALTH_FILE='+str(root/'health')+'\n');unit=root/'unit';unit.write_text('test-unit');(root/'stop-variants-release.json').write_text('{"build_sha":"old-test"}')
   self.pools[pool]={'unit':u,'root':str(root),'process_sha256':digest(b),'files':{'env':{'path':str(e),'sha256':digest(e)},'unit':{'path':str(unit),'sha256':digest(unit)}}};self.writeproc(pool,self.units[u]['MainPID']);self.health(pool)
  self.cleanup=self.r/'cleanup.py';self.cleanup.write_text('class RoomAPI:\n def __init__(self,*args): pass\n def post(self,*args): return {"rooms": []}\n')
  spec={'source_commit':'262dfe9c0a7bc9c44769670e0312bcb66cb32671','binary_sha256':digest(self.d/'worker-candidate'),'helper_sha256':digest(self.d/'asr_diagnostic_env.py'),'deployer_sha256':digest(PATH),'device_sns':SNS,'until_ms':1000000000,'reviewed':True,'pools':self.pools};(self.d/'SPEC.json').write_text(json.dumps(spec))
  self.real_spec=importlib.util.spec_from_file_location
  self.context=contextlib.ExitStack();self.context.enter_context(patch.object(self.m,'Path',self.path));self.context.enter_context(patch.object(self.m.subprocess,'check_output',self.check_output));self.context.enter_context(patch.object(self.m.subprocess,'run',self.proc_run));self.context.enter_context(patch.object(self.m.time,'sleep',lambda _:None));self.context.enter_context(patch.object(self.m.time,'time',lambda:self.clock));self.context.enter_context(patch.object(self.m.importlib.util,'spec_from_file_location',self.load_spec))
 def tearDown(self):self.context.close();self.temp.cleanup()
 def path(self,p,*parts):
  s=str(p)
  if s=='/proc' or s.startswith('/proc/'):p=self.proc/s.removeprefix('/proc').lstrip('/')
  elif s=='/var/lib/p003-business-cleanup/status.json':p=self.r/'cleanup-status'
  return pathlib.Path(p,*parts)
 def load_spec(self,name,path):return self.real_spec(name,self.cleanup if str(path)=='/opt/p003-business-cleanup/reconcile_rooms.py' else path)
 def writeproc(self,pool,pid):
  root=pathlib.Path(self.pools[pool]['root']) if pool in self.pools else self.r/pool;p=self.proc/pid;p.mkdir(exist_ok=True);(p/'exe').write_bytes((root/'voice-rust-worker').read_bytes());(p/'environ').write_bytes(b'\0'.join((root/'env').read_bytes().splitlines()));(p/'cmdline').write_bytes(b'worker');(p/'cgroup').write_text('test')
 def health(self,pool):
  (self.r/pool/'health').write_text(json.dumps({'registered':True,'jobs':0,'cleanup':{'healthy':True},'at_ms':self.clock*1000}));(self.r/'cleanup-status').write_text(json.dumps({'healthy':not self.busy,'remaining':1 if self.busy else 0,'at_ms':self.clock*1000}))
 def check_output(self,args,**kwargs):
  if args[0]=='hostname':return 'voice-worker-hk2\n'
  if args[0]=='systemctl':return '\n'.join(k+'='+v for k,v in self.units[args[2]].items())+'\n'
  if args[0]=='journalctl':return '' if self.starts==self.fail_start_number else 'registered worker\n'
  raise AssertionError(args)
 def proc_run(self,args,**kwargs):
  assert args[:1]==['systemctl'];pool='main' if args[2]=='voice-worker-rust' else 'listening';u=self.units[args[2]]
  if args[1]=='stop':self.stops+=1;u.update(MainPID='0',ActiveState='inactive')
  elif args[1]=='start':
   self.starts+=1;pid=str(200+self.starts);u.update(MainPID=pid,ActiveState='active')
   if self.inject and self.starts==1:
    p=self.r/pool/'env';p.write_bytes(p.read_bytes().replace(b'old-test-value',b'rotated-test-value'))
   self.writeproc(pool,pid);self.health(pool)
  else:raise AssertionError(args)
 def invoke(self,pool,mode):
  with contextlib.redirect_stdout(io.StringIO()):self.m.main(pool,mode)
 def test_main_apply_and_rollback(self):
  self.invoke('main','apply');self.assertEqual((self.r/'main/voice-rust-worker').read_bytes(),b'reviewed-main');self.assertEqual(self.units['p003-listening-worker']['MainPID'],'101');self.invoke('main','rollback');self.assertEqual((self.r/'main/voice-rust-worker').read_bytes(),b'main-original');self.assertNotIn(b'P003_ASR_DIAGNOSTICS', (self.r/'main/env').read_bytes())
 def test_listening_only_env_changes(self):
  self.invoke('listening','apply');self.assertEqual((self.r/'listening/voice-rust-worker').read_bytes(),b'listening-original');self.invoke('listening','rollback');self.assertEqual(self.units['voice-worker-rust']['MainPID'],'100')
 def test_failure_rolls_back_without_erasing_rotated_key(self):
  self.inject=True
  with self.assertRaises(AssertionError):self.invoke('main','apply')
  self.assertEqual((self.r/'main/voice-rust-worker').read_bytes(),b'main-original');self.assertIn(b'rotated-test-value',(self.r/'main/env').read_bytes());self.assertNotIn(b'P003_ASR_DIAGNOSTICS',(self.r/'main/env').read_bytes());self.assertEqual(self.units['voice-worker-rust']['ActiveState'],'active')
 def test_busy_cleanup_never_stops(self):
  self.busy=True;self.health('main')
  with self.assertRaises(AssertionError):self.invoke('main','apply')
  self.assertEqual(self.stops,0)
 def test_runtime_drift_never_stops(self):
  (self.r/'main/voice-rust-worker').write_bytes(b'other-writer')
  with self.assertRaises(AssertionError):self.invoke('main','apply')
  self.assertEqual(self.stops,0)
 def test_failed_explicit_rollback_recovers_pre_rollback_candidate(self):
  self.invoke('main','apply');self.fail_start_number=2
  with self.assertRaises(RuntimeError):self.invoke('main','rollback')
  self.assertEqual((self.r/'main/voice-rust-worker').read_bytes(),b'reviewed-main');self.assertEqual(self.units['voice-worker-rust']['ActiveState'],'active');self.assertIn(b'P003_ASR_DIAGNOSTICS_SN_ALLOW',(self.r/'main/env').read_bytes())
if __name__=='__main__':unittest.main()
