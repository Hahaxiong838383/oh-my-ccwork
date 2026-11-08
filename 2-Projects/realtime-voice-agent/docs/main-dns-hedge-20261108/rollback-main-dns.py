import pathlib,subprocess,hashlib,json,importlib.util,time,os,re,fcntl,datetime,sys
D=pathlib.Path('/root/p003-main-dns-hedge-20261108');B=D/'dns-hedge-rollback-audit';B.mkdir(exist_ok=True,mode=0o700)
U='voice-worker-rust.service';BIN=pathlib.Path('/root/rust-worker/voice-rust-worker');ENV=pathlib.Path('/root/rust-worker/rust-worker.env');STAGE=D/'dns-hedge-before'/'voice-rust-worker'
OLD='553629a0adeb31fa77d89fb751705c25d906895e98d006bb9471820430f10705';NEW='057f19722de3c2711a50ebb88d2768b8ab36111927495eb8efeda2ee286c426d'
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def unit(n):return dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',n,'-p','MainPID','-p','NRestarts','-p','ActiveState'],text=True).splitlines())
def record(n,v):p=B/n;p.write_text(json.dumps(v,indent=2));p.chmod(0o600)
lock=(B/'lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);assert not(B/'deployed.json').exists()
before=unit(U);pid=before['MainPID'];assert before['ActiveState']=='active'
assert sha(BIN)==sha('/proc/'+pid+'/exe')==OLD and sha(STAGE)==NEW
e=dict(os.fsdecode(x).split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
protected={str(p):sha(p)for p in [ENV,pathlib.Path('/etc/systemd/system/voice-worker-rust.service'),pathlib.Path('/etc/systemd/resolved.conf.d/60-p003-negative-cache.conf'),pathlib.Path('/run/systemd/resolve/stub-resolv.conf'),pathlib.Path('/run/systemd/resolve/resolv.conf')]}
release=json.loads((D/'dns-hedge-before'/'deployed.json').read_text())
assert protected[str(ENV)]==release['env_after_sha256']
assert e.get('P003_TTS_DNS_HEDGE_V1')=='1'
new_env=(D/'dns-hedge-before'/'rust-worker.env').read_bytes();assert hashlib.sha256(new_env).hexdigest()==release['env_before_sha256']
expected=dict(protected);expected[str(ENV)]=hashlib.sha256(new_env).hexdigest()
def write_env(data):
 p=ENV.with_name(ENV.name+'.dns-hedge-tmp');p.write_bytes(data);p.chmod(0o600);os.replace(p,ENV)
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
 p=BIN.with_name(BIN.name+'.dns-hedge-tmp');p.write_bytes(data);p.chmod(0o755);os.replace(p,BIN)
def healthy(want):
 for _ in range(20):
  time.sleep(1);u=unit(U);p=u['MainPID']
  if p!='0'and u['ActiveState']=='active'and sha('/proc/'+p+'/exe')==want:
   s=subprocess.check_output(['journalctl','-u',U,'_PID='+p,'--no-pager','-o','cat'],text=True)
   if 'registered worker'in s:return u
 raise RuntimeError('worker registration failed')
guard();idle(pid)
if '--check' in sys.argv:
 print(json.dumps({'status':'PRECHECK_PASS','current_sha256':OLD,'target_sha256':NEW,'env_before_sha256':protected[str(ENV)],'env_after_sha256':expected[str(ENV)],'other_pools':others,'idle':True}));raise SystemExit(0)
for src in [BIN,ENV,pathlib.Path('/etc/systemd/system/voice-worker-rust.service')]:
 p=B/src.name
 if p.exists():assert sha(p)==sha(src)
 else:p.write_bytes(src.read_bytes());p.chmod(0o600)
record('before.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime':before,'old_sha':OLD,'candidate_sha':NEW,'old_source_commit':'5453c80ffed18c76c93c79be2fb3b52f64e0c043','source_commit':'e9806c7f97e98ade57204242058c02a74673f075','protected':protected,'other_pools':others})
guard();idle(pid);stopped=False
try:
 service('stop');stopped=True;assert not pathlib.Path('/proc',pid).exists();assert sha(BIN)==OLD
 atomic(STAGE.read_bytes());write_env(new_env);service('start');after=healthy(NEW)
 actual_env=dict(os.fsdecode(x).split('=',1)for x in pathlib.Path('/proc',after['MainPID'],'environ').read_bytes().split(b'\0')if b'='in x)
 assert actual_env.get('P003_ASR_CONNECT_RECOVERY_V1')=='1' and actual_env.get('P003_TTS_DNS_HEDGE_V1') is None
 assert {k:v for k,v in actual_env.items()if k not in ['P003_TTS_DNS_HEDGE_V1','INVOCATION_ID','JOURNAL_STREAM','SYSTEMD_EXEC_PID']}=={k:v for k,v in e.items()if k not in ['P003_TTS_DNS_HEDGE_V1','INVOCATION_ID','JOURNAL_STREAM','SYSTEMD_EXEC_PID']}
 assert {p:sha(p)for p in expected}==expected
 assert {n:{**unit(n),'sha256':sha('/proc/'+unit(n)['MainPID']+'/exe')}for n in others}==others
 result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'TTS_DNS_HEDGE_ROLLED_BACK','before':before,'after':after,'sha256':sha(BIN),'source_commit':'e9806c7f97e98ade57204242058c02a74673f075','other_pools_unchanged':True,'system_dns_and_unit_unchanged':True,'dns_hedge_enabled':False,'env_before_sha256':protected[str(ENV)],'env_after_sha256':sha(ENV),'asr_recovery_enabled':True,'scope':'main pool TTS DNS fallback only; business enforcement and other configuration unchanged','backup':str(B)}
 record('deployed.json',result);print(json.dumps(result))
except BaseException:
 if stopped:
  try:
   idle(unit(U)['MainPID']);service('stop');assert sha(BIN)in[OLD,NEW];assert sha(ENV)in[protected[str(ENV)],expected[str(ENV)]];atomic((B/'voice-rust-worker').read_bytes());write_env((B/'rust-worker.env').read_bytes());service('start');healthy(OLD);record('restored.json',{'restored':True,'at':time.time()})
  except BaseException as err:record('rollback-needs-review.json',{'error_type':type(err).__name__,'at':time.time()})
 raise
