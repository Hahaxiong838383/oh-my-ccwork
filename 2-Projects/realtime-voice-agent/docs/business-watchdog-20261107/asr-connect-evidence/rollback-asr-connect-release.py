import pathlib,subprocess,hashlib,json,importlib.util,time,os,re,fcntl,datetime
D=pathlib.Path('/root/p003-business-watchdog-20261107');B=D/'asr-connect-before';U='voice-worker-rust.service';BIN=pathlib.Path('/root/rust-worker/voice-rust-worker');ENV=BIN.parent/'rust-worker.env'
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def unit(n):return dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',n,'-p','MainPID','-p','NRestarts','-p','ActiveState'],text=True).splitlines())
lock=(B/'lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
before=json.loads((B/'before.json').read_text());deployed=json.loads((B/'deployed.json').read_text());u=unit(U);pid=u['MainPID']
assert not(B/'post-test-rollback.json').exists()
assert sha(BIN)==sha('/proc/'+pid+'/exe')==deployed['sha256']
assert sha(ENV)==deployed['env_after_sha256']
assert sha(B/'voice-rust-worker')==before['old_sha'] and sha(B/'rust-worker.env')==before['protected'][str(ENV)]
for p,h in before['protected'].items():
 if p!=str(ENV):assert sha(p)==h
others={n:{**unit(n),'sha256':sha('/proc/'+unit(n)['MainPID']+'/exe')}for n in before['other_pools']};assert others==before['other_pools']
e=dict(os.fsdecode(x).split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
spec=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);api=m.RoomAPI(e['LIVEKIT_URL'],e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET'])
assert not api.post('ListRooms',{}).get('rooms',[]),'active room: postpone rollback'
q=subprocess.run(['journalctl','-u',U,'_PID='+pid,'--no-pager','--grep=job assignment received|process exiting','-o','cat'],capture_output=True,text=True,timeout=10);assert q.returncode in[0,1]and not q.stderr.strip();a=set();b=set()
for l in re.sub(r'\x1b\[[0-9;]*m','',q.stdout).splitlines():
 j=re.search(r'job_id="?([^\s"]+)',l)
 if j:(a if 'job assignment received'in l else b).add(j[1])
assert not(a-b),'unfinished job: postpone rollback'
assert unit(U)==u and sha(ENV)==deployed['env_after_sha256'] and not api.post('ListRooms',{}).get('rooms',[])
subprocess.run(['systemctl','stop',U],check=True,timeout=25)
assert not pathlib.Path('/proc',pid).exists()
for dest,src,mode in [(BIN,B/'voice-rust-worker',0o755),(ENV,B/'rust-worker.env',0o600)]:
 temp=dest.with_name(dest.name+'.rollback-tmp');temp.write_bytes(src.read_bytes());temp.chmod(mode);os.replace(temp,dest)
subprocess.run(['systemctl','start',U],check=True,timeout=25)
registered=False
for _ in range(20):
 time.sleep(1);v=unit(U)
 if v['MainPID']!='0' and v['ActiveState']=='active' and sha('/proc/'+v['MainPID']+'/exe')==before['old_sha']:
  j=subprocess.check_output(['journalctl','-u',U,'_PID='+v['MainPID'],'--no-pager','-o','cat'],text=True)
  if 'registered worker'in j:registered=True;break
assert registered
assert {n:{**unit(n),'sha256':sha('/proc/'+unit(n)['MainPID']+'/exe')}for n in others}==others
result={'status':'POST_TEST_ROLLBACK_COMPLETE','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'main':v,'sha256':sha(BIN),'env_sha256':sha(ENV),'other_pools_unchanged':True}
(B/'post-test-rollback.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
