from pathlib import Path
import subprocess,json,hashlib,time,os,shutil,re,fcntl,importlib.util
os.umask(0o077)
D=Path('/root/p003-business-watchdog-20261107');B=D/'listening-feedback-before-20261108'
UNIT='p003-listening-worker';root=Path('/opt/p003-listening-canary-20261030');exe=root/'voice-rust-worker';envpath=root/'canary.env';meta=root/'release.json';stage=D/'worker-listening-feedback-1e9ec83a';health_path=Path('/run/p003-listening-canary/health.json')
OLD='d627dfa91f33fd01771c87bc6ac2bbb6a3ccb937b823bf7e0bd56ec92e1ab0e0';NEW='1e9ec83ad10ff94c29601645d89fa39a0ca2fed43bae9d71017c1f2631c40aae';BUILD='50bac0b28c4f44e169ad574c08682fe509a72a46'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def props(unit):return dict(line.split('=',1)for line in subprocess.check_output(['systemctl','show',unit,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines())
def atomic(p,b,mode=0o600):
 t=p.with_name(p.name+'.feedback-20261108.tmp')
 with t.open('wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
 t.chmod(mode);os.replace(t,p)
def drain():
 subprocess.run(['systemctl','stop',UNIT],check=True,timeout=30)
 assert props(UNIT)['MainPID']=='0'and props(UNIT)['ActiveState']=='inactive','stop_incomplete'
 cg=Path('/sys/fs/cgroup/system.slice/'+UNIT+'.service/cgroup.procs');assert not cg.exists()or not cg.read_text().strip(),'children_remaining'
 sock=Path('/run/p003-listening-canary/eot.sock')
 if sock.exists():assert sock.is_socket();sock.unlink()
def ready(want,since):
 end=time.monotonic()+25
 while time.monotonic()<end:
  try:
   p=props(UNIT);h=json.loads(health_path.read_text());pid=p['MainPID']
   if p['ActiveState']=='active'and h['at_ms']>=since and h['registered']and h['cleanup']['healthy']and int(time.time()*1000)-h['at_ms']<6000 and sha(Path('/proc')/pid/'exe')==want:return {'unit':p,'health':h,'binary_sha256':want}
  except (FileNotFoundError,ProcessLookupError,ValueError):pass
  time.sleep(.5)
 raise RuntimeError('startup_not_ready')
assert not(B/'receipt.json').exists(),'already_attempted'
B.mkdir(mode=0o700,exist_ok=True);lock=(B/'lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert sha(exe)==OLD and sha(stage)==NEW and stage.stat().st_size==77996640,'binary_drift'
assert sha(envpath)=='effe57e0e200bd7aad67ae06329939a394a1b586d6699c4c7ad6b9e6836e787b','env_drift'
assert sha(meta)=='8864d02ed14343229cb7ce01cfec7455208ba29268e0d0a77191f99bacec1607','release_drift'
p=props(UNIT);assert sha(Path('/proc')/p['MainPID']/'exe')==OLD
protected={u:props(u)for u in ['voice-worker-rust','p003-search-worker']}
paths=[root/'window.json',root/'v374-window.json',Path('/etc/systemd/system/p003-listening-worker.service'),Path('/root/rust-worker/voice-rust-worker'),Path('/root/rust-worker/rust-worker.env'),Path('/opt/p003-search-canary-20261021/voice-rust-worker'),Path('/opt/p003-search-canary-20261021/canary.env'),Path('/opt/p003-search-canary-20261021/window.json')]
protected_files={str(f):sha(f)for f in paths}
assert protected_files[str(root/'window.json')]=='1bf79805eee4d3f00f6503c41e8d9f2fcde3f2c2c97907f8b325bb81509aa249'
old_env=envpath.read_bytes();new_env=old_env
old_meta=meta.read_bytes();assert json.loads(old_meta)['build_sha']=='de09010304f2a44556bd706c7b810828062b4433'
env=dict(os.fsdecode(x).split('=',1)for x in Path('/proc',p['MainPID'],'environ').read_bytes().split(b'\0')if b'='in x)
spec=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);api=m.RoomAPI(env['LIVEKIT_URL'],env['LIVEKIT_API_KEY'],env['LIVEKIT_API_SECRET'])
def idle():
 h=json.loads(health_path.read_text());assert h['registered']and h['jobs']==0 and h['cleanup']['healthy']and 0<=int(time.time()*1000)-h['at_ms']<6000,'busy_or_stale'
 assert not api.post('ListRooms',{}).get('rooms',[]),'active_rooms_wait_for_idle'
 return h
assert 'not found'not in subprocess.check_output(['ldd',str(stage)],text=True,timeout=10)
assert shutil.disk_usage('/root').free>1024**3
idle()
for f,name in [(exe,'voice-rust-worker'),(envpath,'canary.env'),(meta,'release.json'),(Path('/etc/systemd/system/p003-listening-worker.service'),'unit.service')]:
 target=B/name
 if target.exists():assert sha(target)==sha(f)
 else:atomic(target,f.read_bytes())
baseline={'unit':p,'protected':protected,'files':protected_files,'env_sha256':sha(envpath),'release_sha256':sha(meta),'old_sha256':OLD,'candidate_sha256':NEW};atomic(B/'baseline.json',json.dumps(baseline,indent=2).encode())
result={'backup':str(B),'started_ms':int(time.time()*1000),'build':BUILD,'candidate_sha256':NEW};attempted=False;installed=False
try:
 idle();assert props(UNIT)==p and sha(exe)==OLD and envpath.read_bytes()==old_env and meta.read_bytes()==old_meta
 assert all(sha(Path(n))==v for n,v in protected_files.items())
 attempted=True;drain();assert sha(exe)==OLD
 installed=True;atomic(exe,stage.read_bytes(),0o755);atomic(envpath,new_env)
 atomic(meta,(json.dumps({'build_sha':BUILD,'binary_sha256':NEW,'bytes':77996640},indent=2)+'\n').encode())
 since=int(time.time()*1000);subprocess.run(['systemctl','start',UNIT],check=True,timeout=30);result['runtime']=ready(NEW,since)
 actual=dict(os.fsdecode(x).split('=',1)for x in Path('/proc',result['runtime']['unit']['MainPID'],'environ').read_bytes().split(b'\0')if b'='in x)
 flags=['P003_TTS_CONNECT_RECOVERY_V1','P003_ASR_CONNECT_RECOVERY_V1','P003_ASYNC_DNS_V1','P003_TTS_DNS_HEDGE_V1','P003_TTS_LATENCY_V1','P003_TTS_FIRST_PCM_BUDGET_MS']
 assert all(actual.get(k)=='1'for k in flags[:-1])and actual.get(flags[-1])=='10000'
 assert all(props(u)==v for u,v in protected.items()),'protected_unit_changed'
 assert all(sha(Path(n))==v for n,v in protected_files.items()),'protected_file_changed'
 result.update(success=True,flags={k:actual.get(k)for k in flags},env_before_sha256=hashlib.sha256(old_env).hexdigest(),env_after_sha256=sha(envpath),other_pools_unchanged=True)
except BaseException as error:
 result.update(success=False,error_type=type(error).__name__,error=str(error)[:120])
 if installed:
  assert sha(exe)in[OLD,NEW],'rollback_binary_drift';drain();atomic(exe,(B/'voice-rust-worker').read_bytes(),0o755);atomic(envpath,old_env);atomic(meta,old_meta)
 if attempted:
  since=int(time.time()*1000);subprocess.run(['systemctl','start',UNIT],check=True,timeout=30);result['rollback_runtime']=ready(OLD,since);result['rolled_back']=True
finally:
 result['ended_ms']=int(time.time()*1000);atomic(B/'receipt.json',json.dumps(result,indent=2).encode());print(json.dumps(result))
if not result['success']:raise SystemExit(1)
