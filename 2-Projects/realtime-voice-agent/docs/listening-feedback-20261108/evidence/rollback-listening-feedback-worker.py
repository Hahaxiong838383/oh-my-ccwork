from pathlib import Path
import subprocess,json,hashlib,time,os,importlib.util
D=Path('/root/p003-business-watchdog-20261107');B=D/'listening-feedback-before-20261108';root=Path('/opt/p003-listening-canary-20261030');UNIT='p003-listening-worker'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
r=json.loads((B/'receipt.json').read_text());assert r['success'];baseline=json.loads((B/'baseline.json').read_text())
pid=subprocess.check_output(['systemctl','show',UNIT,'-p','MainPID','--value'],text=True).strip();assert sha('/proc/'+pid+'/exe')==sha(root/'voice-rust-worker')==r['candidate_sha256']
assert sha(root/'release.json')=='4ca965007f501c3c227d53dd367fc7cde96af36819eb4b0dca9e6ef308f08fc0','release metadata drift'
assert sha(B/'voice-rust-worker')==baseline['old_sha256'] and sha(B/'canary.env')==baseline['env_sha256'] and sha(B/'release.json')==baseline['release_sha256'],'backup drift'
assert sha(root/'canary.env')==r['env_after_sha256'];h=json.loads(Path('/run/p003-listening-canary/health.json').read_text());assert h['jobs']==0 and time.time()*1000-h['at_ms']<6000
assert all(sha(p)==v for p,v in baseline['files'].items()),'protected_file_drift'
e=dict(os.fsdecode(x).split('=',1)for x in Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
spec=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);api=m.RoomAPI(e['LIVEKIT_URL'],e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET']);assert not api.post('ListRooms',{}).get('rooms',[]),'active rooms wait for drain'
subprocess.run(['systemctl','stop',UNIT],check=True,timeout=30)
assert not Path('/proc',pid).exists()
for name,mode in [('voice-rust-worker',0o755),('canary.env',0o600),('release.json',0o600)]:
 target=root/name;t=target.with_suffix('.feedback-rollback.tmp');t.write_bytes((B/name).read_bytes());t.chmod(mode);os.replace(t,target)
sock=Path('/run/p003-listening-canary/eot.sock')
if sock.exists():assert sock.is_socket();sock.unlink()
subprocess.run(['systemctl','start',UNIT],check=True,timeout=30)
for _ in range(25):
 time.sleep(1);pid=subprocess.check_output(['systemctl','show',UNIT,'-p','MainPID','--value'],text=True).strip()
 if pid!='0'and sha('/proc/'+pid+'/exe')==baseline['old_sha256']:
  h=json.loads(Path('/run/p003-listening-canary/health.json').read_text())
  if h['registered']and h['cleanup']['healthy']and time.time()*1000-h['at_ms']<6000:break
else:raise RuntimeError('rollback_not_ready')
out={'restored':True,'pid':pid,'sha256':sha(root/'voice-rust-worker'),'env_sha256':sha(root/'canary.env'),'at_ms':int(time.time()*1000)};(B/'manual-rollback-receipt.json').write_text(json.dumps(out));print(json.dumps(out))
