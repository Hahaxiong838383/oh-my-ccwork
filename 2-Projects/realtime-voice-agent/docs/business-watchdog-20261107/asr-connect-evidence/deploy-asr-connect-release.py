import pathlib,subprocess,hashlib,json,importlib.util,time,os,re,fcntl,datetime
D=pathlib.Path('/root/p003-business-watchdog-20261107');B=D/'asr-connect-before';B.mkdir(exist_ok=True,mode=0o700)
U='voice-worker-rust.service';BIN=pathlib.Path('/root/rust-worker/voice-rust-worker');ENV=pathlib.Path('/root/rust-worker/rust-worker.env');STAGE=D/'worker-asr-connect-3dd0430a'
OLD='50017a8998197d84fcc58957e0979ea13f56aabe0758ba9ea2ab2aff468de4d0';NEW='3dd0430aaf97d3ef5d056d871f3d87a64c66508c0b9b8cf9702bc9f0e73e70cb'
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def unit(n):return dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',n,'-p','MainPID','-p','NRestarts','-p','ActiveState'],text=True).splitlines())
def record(n,v):p=B/n;p.write_text(json.dumps(v,indent=2));p.chmod(0o600)
lock=(B/'lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);assert not(B/'deployed.json').exists()
before=unit(U);pid=before['MainPID'];assert before['ActiveState']=='active'
assert sha(BIN)==sha('/proc/'+pid+'/exe')==OLD and sha(STAGE)==NEW
e=dict(os.fsdecode(x).split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
protected={str(p):sha(p)for p in [ENV,pathlib.Path('/etc/systemd/system/voice-worker-rust.service'),pathlib.Path('/etc/systemd/resolved.conf.d/60-p003-negative-cache.conf')]}
assert protected[str(ENV)]=='d5c4c7788569c7ab3c6ec47423fcd9997a6b6a7a4f04dc7d5ff9feed4df3dcde'
assert not re.search(rb'(?m)^(?:export )?P003_ASR_CONNECT_RECOVERY_V1=',ENV.read_bytes())
new_env=ENV.read_bytes()+b'\nP003_ASR_CONNECT_RECOVERY_V1=1\n'
expected=dict(protected);expected[str(ENV)]=hashlib.sha256(new_env).hexdigest()
def write_env(data):
 p=ENV.with_name(ENV.name+'.asr-connect-tmp');p.write_bytes(data);p.chmod(0o600);os.replace(p,ENV)
others={n:{**unit(n),'sha256':sha('/proc/'+unit(n)['MainPID']+'/exe')}for n in ['p003-search-worker.service','p003-listening-worker.service']}
assert 'not found'not in subprocess.check_output(['ldd',str(STAGE)],text=True,timeout=10)
spec=importlib.util.spec_from_file_location('cleanup','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);api=m.RoomAPI(e['LIVEKIT_URL'],e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET'])
def idle(p):
 assert not api.post('ListRooms',{}).get('rooms',[]),'active rooms'
 if p=='0':return
 q=subprocess.run(['journalctl','-u',U,'_PID='+p,'--no-pager','--grep=job assignment received|process exiting','-o','cat'],capture_output=True,text=True,timeout=10)
 assert q.returncode in[0,1]and not q.stderr.strip();s=re.sub(r'\x1b\[[0-9;]*m','',q.stdout);a=set();b=set()
 for l in s.splitlines():
  j=re.search(r'job_id="?([^\s"]+)',l)
  if j:(a if 'job assignment received'in l else b).add(j[1])
 assert not(a-b),'unfinished jobs'
 status=json.loads(pathlib.Path('/var/lib/p003-business-cleanup/status.json').read_text());assert status['healthy']and status['remaining']==0 and time.time()*1000-status['at_ms']<120000
def guard():
 assert unit(U)==before and sha(BIN)==OLD
 assert {p:sha(p)for p in protected}==protected
 assert {n:{**unit(n),'sha256':sha('/proc/'+unit(n)['MainPID']+'/exe')}for n in others}==others
def service(action):subprocess.run(['systemctl',action,U],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=25)
def atomic(data):
 p=BIN.with_name(BIN.name+'.asr-tmp');p.write_bytes(data);p.chmod(0o755);os.replace(p,BIN)
def healthy(want):
 for _ in range(20):
  time.sleep(1);u=unit(U);p=u['MainPID']
  if p!='0'and u['ActiveState']=='active'and sha('/proc/'+p+'/exe')==want:
   s=subprocess.check_output(['journalctl','-u',U,'_PID='+p,'--no-pager','-o','cat'],text=True)
   if 'registered worker'in s:return u
 raise RuntimeError('worker registration failed')
guard();idle(pid)
for src in [BIN,ENV,pathlib.Path('/etc/systemd/system/voice-worker-rust.service')]:
 p=B/src.name
 if p.exists():assert sha(p)==sha(src)
 else:p.write_bytes(src.read_bytes());p.chmod(0o600)
record('before.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime':before,'old_sha':OLD,'candidate_sha':NEW,'source_commit':'713f6f35af43d5a58aeae8360ad421fc66b72718','protected':protected,'other_pools':others})
guard();idle(pid);stopped=False
try:
 service('stop');stopped=True;assert not pathlib.Path('/proc',pid).exists();assert sha(BIN)==OLD
 atomic(STAGE.read_bytes());write_env(new_env);service('start');after=healthy(NEW)
 actual_env=dict(os.fsdecode(x).split('=',1)for x in pathlib.Path('/proc',after['MainPID'],'environ').read_bytes().split(b'\0')if b'='in x)
 assert actual_env.get('P003_ASR_CONNECT_RECOVERY_V1')=='1'
 assert {p:sha(p)for p in expected}==expected
 assert {n:{**unit(n),'sha256':sha('/proc/'+unit(n)['MainPID']+'/exe')}for n in others}==others
 result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'ASR_CONNECT_AND_RECOGNITION_DEPLOYED','before':before,'after':after,'sha256':sha(BIN),'source_commit':'713f6f35af43d5a58aeae8360ad421fc66b72718','other_pools_unchanged':True,'dns_and_unit_unchanged':True,'env_before_sha256':protected[str(ENV)],'env_after_sha256':sha(ENV),'asr_recovery_enabled':True,'scope':'main pool connector; business enforcement stays existing allowlist','backup':str(B)}
 record('deployed.json',result);print(json.dumps(result))
except BaseException:
 if stopped:
  try:
   idle(unit(U)['MainPID']);service('stop');assert sha(BIN)in[OLD,NEW];assert sha(ENV)in[protected[str(ENV)],expected[str(ENV)]];atomic((B/'voice-rust-worker').read_bytes());write_env((B/'rust-worker.env').read_bytes());service('start');healthy(OLD);record('restored.json',{'restored':True,'at':time.time()})
  except BaseException as err:record('rollback-needs-review.json',{'error_type':type(err).__name__,'at':time.time()})
 raise
