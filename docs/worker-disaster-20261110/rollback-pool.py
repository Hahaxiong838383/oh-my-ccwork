from pathlib import Path
import os,sys,json,hashlib,subprocess,time,fcntl,importlib.util
os.umask(0o077)
pool=sys.argv[1];assert pool in ['main'];apply=len(sys.argv)>2 and sys.argv[2]=='--apply'
D=Path('/root/p003-worker-disaster-fallback-20261110');B=D/('before-'+pool)
lock=(D/'deploy.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
b=json.loads((B/'baseline.json').read_text());r=json.loads((B/'receipt.json').read_text());assert r['success']
u='voice-worker-rust'if pool=='main'else'p003-listening-worker'
root=Path('/root/rust-worker'if pool=='main'else'/opt/p003-listening-canary-20261030');exe=root/'voice-rust-worker';envpath=root/('rust-worker.env'if pool=='main'else'canary.env')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def unit():return dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',u,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines())
def atomic(p,data,mode):
 t=p.with_name(p.name+'.rollback.tmp');t.write_bytes(data);t.chmod(mode);os.replace(t,p)
v=unit();assert sha(exe)==sha(Path('/proc',v['MainPID'],'exe'))==b['new_sha256']
assert sha(envpath)==r['env_after_sha256'] and sha(B/'voice-rust-worker')==b['old_sha256']
assert all(sha(p)==h for p,h in b['protected'].items())
publisher=root/'apply_hotwords.py';assert sha(publisher)==r['publisher_sha256'];assert sha(B/'apply_hotwords.py')==json.loads((D/'manifest.json').read_text())[0]['before']
if pool=='listening':assert json.loads((root/'release.json').read_text())['build_sha']==b['source_commit']
if not apply:print(json.dumps({'pool':pool,'rollback_check':'PASS','backup':str(B),'applied':False}));raise SystemExit()
e=dict(os.fsdecode(x).split('=',1)for x in Path('/proc',v['MainPID'],'environ').read_bytes().split(b'\0')if b'='in x)
spec=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);api=m.RoomAPI(e['LIVEKIT_URL'],e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET']);assert not api.post('ListRooms',{}).get('rooms',[]),'active rooms: wait for idle'
subprocess.run(['systemctl','stop',u],check=True,timeout=30);assert unit()['MainPID']=='0'
if pool=='listening':
 p=Path('/run/p003-listening-canary/eot.sock')
 if p.exists():assert p.is_socket();p.unlink()
atomic(exe,(B/'voice-rust-worker').read_bytes(),0o755);atomic(envpath,(B/'env').read_bytes(),0o600);atomic(publisher,(B/'apply_hotwords.py').read_bytes(),0o755)
if pool=='listening':atomic(root/'release.json',(B/'release.json').read_bytes(),0o600)
subprocess.run(['systemctl','start',u],check=True,timeout=30)
for _ in range(40):
 time.sleep(.5);v=unit()
 if v['ActiveState']=='active'and v['MainPID']!='0'and sha(Path('/proc',v['MainPID'],'exe'))==b['old_sha256']:
  raw=subprocess.check_output(['journalctl','-u',u,'_PID='+v['MainPID'],'-o','cat','--no-pager'],text=True)
  if 'registered worker'in raw:break
else:raise RuntimeError('rollback health failed')
out={'pool':pool,'rollback':'PASS','unit':v,'sha256':b['old_sha256'],'at_ms':int(time.time()*1000)};(B/'rollback-receipt.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
