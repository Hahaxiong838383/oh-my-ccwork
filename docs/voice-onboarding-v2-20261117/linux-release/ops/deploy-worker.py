from pathlib import Path
import fcntl,hashlib,importlib.util,json,os,subprocess,sys,time
os.umask(0o077)
D=Path('/root/p003-onboarding-release-20261117');ROOT=Path('/root/rust-worker');B=ROOT/'voice-rust-worker';E=ROOT/'rust-worker.env';U='voice-worker-rust'
OLD='d37a39633ed8e7766e35744baf0b78ca2fbc12777a91b9a89f166029748c1c69';NEW='53797c7574344f7cbb2258f9b238ef1c4ae2ab4563459424cf2dc848cf492e95'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def unit(u=U):return dict(v.split('=',1)for v in subprocess.check_output(['systemctl','show',u,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines())
def atomic(p,b,mode):
 t=p.with_name(p.name+'.onboarding.tmp');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
 try:
  with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
  os.replace(t,p)
 finally:
  if t.exists():t.unlink()
def env(pid):return dict(os.fsdecode(x).split('=',1)for x in Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
def main(mode):
 assert mode in ('check','apply','rollback');assert subprocess.check_output(['hostname'],text=True).strip()=='voice-worker-hk2'
 lock=E.with_name(E.name+'.config.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 state=unit();expected=NEW if mode=='rollback'else OLD
 assert state['ActiveState']=='active'and sha(B)==sha(Path('/proc',state['MainPID'],'exe'))==expected,'binary drift'
 assert sha(E)=='a79735aa99122d8497040eec6d6babf32f6e43348619a269288371ad80ab3346','env drift'
 assert sha('/etc/systemd/system/voice-worker-rust.service')=='fc4d00bc4d4a5fcdbdcfd2feed4e0ed658fa447d68904fd6951e725b3731c7d0','unit drift'
 assert sha(D/'worker-candidate')==NEW
 before_env=env(state['MainPID']);other={u:unit(u)for u in ['p003-listening-worker','p003-search-worker']}
 sp=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m);api=m.RoomAPI(before_env['LIVEKIT_URL'],before_env['LIVEKIT_API_KEY'],before_env['LIVEKIT_API_SECRET'])
 def idle():
  assert not api.post('ListRooms',{}).get('rooms',[]),'active rooms; defer'
  h=json.loads(Path('/var/lib/p003-business-cleanup/status.json').read_text());assert h['healthy']and h['remaining']==0 and 0<=time.time()*1000-h['at_ms']<120000,'cleanup unhealthy/stale'
 def unchanged():
  assert unit()==state and sha(B)==expected and sha(E)=='a79735aa99122d8497040eec6d6babf32f6e43348619a269288371ad80ab3346'
  assert {u:unit(u)for u in other}==other
 def stop():
  subprocess.run(['systemctl','stop',U],check=True,timeout=35);assert unit()['MainPID']=='0'
  for _ in range(20):
   owned=[]
   for p in Path('/proc').iterdir():
    if not p.name.isdigit():continue
    try:
     if any(os.path.basename(a)==b'eot_sidecar.py'for a in(p/'cmdline').read_bytes().split(b'\0'))and U+'.service'in(p/'cgroup').read_text():owned.append(p.name)
    except (FileNotFoundError,ProcessLookupError):pass
   if not owned:break
   time.sleep(.5)
  else:raise RuntimeError('owned EOT child not stopped')
  sock=Path(before_env.get('EOT_SOCK','/nonexistent'))
  if sock.exists():assert sock.is_socket();sock.unlink()
 def start(want):
  at=time.time();subprocess.run(['systemctl','start',U],check=True,timeout=30)
  for _ in range(60):
   time.sleep(.5);s=unit();pid=s['MainPID']
   if s['ActiveState']!='active'or pid=='0':continue
   if sha(Path('/proc',pid,'exe'))!=want:continue
   log=subprocess.check_output(['journalctl','-u',U,'_PID='+pid,'--since','@'+str(int(at)),'--no-pager','-o','cat'],text=True)
   if 'registered worker'in log and 'panicked'not in log:return s
  raise RuntimeError('registration failed')
 backup=D/'worker-before';receipt=D/'WORKER-RELEASE.json'
 unchanged();idle()
 if mode=='check':print(json.dumps({'check':True,'idle':True,'no_runtime_mutation':True}));return
 if mode=='rollback':
  assert sha(backup/'binary')==OLD
  unchanged();idle();stop();atomic(B,(backup/'binary').read_bytes(),0o755);after=start(OLD)
  result={'rolled_back':True,'after':after,'at_ms':int(time.time()*1000)};atomic(D/'WORKER-ROLLBACK.json',json.dumps(result).encode(),0o600);print(json.dumps(result));return
 assert not backup.exists()and not receipt.exists();backup.mkdir(mode=0o700)
 atomic(backup/'binary',B.read_bytes(),0o700);atomic(backup/'env',E.read_bytes(),0o600);atomic(backup/'unit',Path('/etc/systemd/system/voice-worker-rust.service').read_bytes(),0o600)
 result={'before':state,'started_ms':int(time.time()*1000),'old_sha':OLD,'new_sha':NEW,'backup':str(backup),'source_commit':'786a135bcc2f42037b117ec2d3582fcb3af2409b','runtime_commit':'42df1d0320aec5338c9d1be2c11de6e514966944','other_before':other}
 stopped=False;written=False
 try:
  unchanged();idle();stopped=True;stop();atomic(B,(D/'worker-candidate').read_bytes(),0o755);written=True
  after=start(NEW);actual=env(after['MainPID'])
  assert all(actual.get(k)==v for k,v in before_env.items()if k.startswith(('P003_','VOLC_','XFYUN_','LLM_','TTS_','AGENT_','WORKER_','LIVEKIT_','EOT_','EXIT_','INTERRUPT_','SESSION_EXIT_'))),'runtime config drift'
  assert {u:unit(u)for u in other}==other
  result.update(success=True,after=after,disk_sha=sha(B),process_sha=sha(Path('/proc',after['MainPID'],'exe')),env_unchanged=sha(E)==sha(backup/'env'),other_pools_unchanged=True)
 except BaseException as ex:
  result.update(success=False,error_type=type(ex).__name__)
  if stopped:
   stop()
   if written:assert sha(B)==NEW;atomic(B,(backup/'binary').read_bytes(),0o755)
   result['rollback']=start(OLD)
  raise
 finally:
  result['finished_ms']=int(time.time()*1000);atomic(receipt,json.dumps(result,indent=2).encode(),0o600);print(json.dumps(result))
if __name__=='__main__':main(sys.argv[1])
