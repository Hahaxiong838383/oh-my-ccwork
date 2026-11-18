from pathlib import Path
import os,sys,json,hashlib,subprocess,time,fcntl,tempfile,shutil,sqlite3,urllib.request
from contextlib import ExitStack
D=Path('/root/p003-clock-release-20261118');I=int(sys.argv[1]);APPLY='--apply' in sys.argv
ROOTS=['/opt/p003/server','/opt/p003/search-canary-20261021/brain','/opt/p003/listening-canary-20261030/brain'];PORTS=[3001,3007,3008];UNITS=[None,'p003-search-brain.service','p003-listening-brain.service'];R=Path(ROOTS[I]);port=PORTS[I]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None

def atomic(p,b,mode=0o600):
 fd,tmp=tempfile.mkstemp(dir=p.parent,prefix='.clock-release-')
 try:
  with os.fdopen(fd,'wb') as f:os.fchmod(f.fileno(),mode);f.write(b);f.flush();os.fsync(f.fileno())
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def write(p,r):atomic(p,(json.dumps(r,indent=2)+'\n').encode())
def pm2():return {p['name']:{'pid':p['pid'],'status':p['pm2_env']['status'],'restarts':p['pm2_env']['restart_time']} for p in json.loads(subprocess.check_output(['pm2','jlist']))}
def service(i):
 if i==0:return pm2()['p003-voice']
 fields=dict(x.split('=',1) for x in subprocess.check_output(['systemctl','show',UNITS[i],'-p','MainPID','-p','NRestarts','-p','ActiveState'],text=True).splitlines());return {'pid':int(fields['MainPID']),'restarts':int(fields['NRestarts']),'status':fields['ActiveState']}
def health():
 with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/health',timeout=2) as r:return r.status==200 and json.load(r).get('status')=='ok'
def restart():
 args=['pm2','restart','p003-voice'] if I==0 else ['systemctl','restart',UNITS[I]]
 subprocess.run(args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=40)
 for _ in range(60):
  time.sleep(.5)
  try:
   if health():return
  except Exception:pass
 raise RuntimeError('health did not recover')
def bindings():
 rows={}
 for root in ROOTS:
  p=Path(root)/'data/devices.db'
  if p.exists():
   with sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True) as db:
    columns={x[1] for x in db.execute('PRAGMA table_info(device_registry)').fetchall()};required=['sn','public_id','account_id','parent_account_id','status'];assert all(c in columns for c in required)
    selected=required+(['binding_version'] if 'binding_version' in columns else [])
    rows[root]={'columns':selected,'rows':db.execute('SELECT '+','.join(selected)+' FROM device_registry ORDER BY sn').fetchall()}
 return hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()
def policies():
 rows={}
 for root in ROOTS:
  with sqlite3.connect('file:'+root+'/data/config.db?mode=ro',uri=True) as db:
   tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
   rows[root]={'search':db.execute("SELECT key,value FROM runtime_flag WHERE key LIKE 'p003.search.%' ORDER BY key").fetchall(),'listening':db.execute('SELECT * FROM listening_settings').fetchall() if 'listening_settings' in tables else []}
 return hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()
def idle():
 r=subprocess.run(['/usr/bin/node','--env-file=.env.local',str(D/'idle-probe.mjs')],cwd=ROOTS[0],capture_output=True,text=True,timeout=20)
 assert r.returncode==0,'live room authority unavailable'
 x=json.loads(r.stdout);assert x['verified'] and x['idle'],'active rooms: retry release later'
 sockets=subprocess.check_output(['ss','-Htn','state','established','sport','=',':'+str(port)],text=True)
 assert not sockets.strip(),'active HTTP streams: retry release later'
 return x
def probe_environment(pid):
 env=dict(os.environ)
 if I:
  raw=Path('/proc/'+str(pid)+'/environ').read_bytes()
  env.update(dict(x.decode().split('=',1) for x in raw.split(b'\0') if b'=' in x))
 env['PORT']=str(port);env['CLOCK_PROBE_RESULT']=str(D/f'PROBE-{I}.json')
 return env
def probe_args():
 return ['/usr/bin/node']+(['--env-file=.env.local'] if I==0 else [])+['--experimental-sqlite',str(D/('live-gray-guard.mjs' if I else 'live-clock-probe.mjs'))]
with ExitStack() as stack:
 # Session360 now uses a second release directory. Share both actual locks;
 # the former dashboard lock alone does not serialize its new publisher.
 for lock_path in ['/root/p003-miniapp-admin-20261117/release.lock','/root/p003-history-identity-fix-20261117/release.lock']:
  lock=stack.enter_context(Path(lock_path).open('a'))
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 assert json.loads((D/'FULL-CANARY-TESTS.json').read_text())['pass'];proof=json.loads((D/'NODE22-TESTS.json').read_text());assert proof['pass'] and proof['complete'] and proof['node']=='v22.22.2'
 manifest_hash=sha(D/'candidate/MANIFEST.json');assert proof['manifest_sha256']==manifest_hash and json.loads((D/'FULL-CANARY-TESTS.json').read_text())['manifest_sha256']==manifest_hash,'test evidence candidate mismatch'
 manifest=json.loads((D/'candidate/MANIFEST.json').read_text());rows=[x for x in manifest if x['pool']==str(R)];assert len(rows)==(4 if I==0 else 1)
 for row in rows:
  assert sha(R/row['path'])==row['before_sha256'],'target drift'
  assert sha(D/'candidate'/str(I)/row['path'])==row['after_sha256'],'candidate drift'
 source_before={p['root']:p['sources'] for p in json.loads((D/'BASELINE.json').read_text())['pools']}
 for j,(root,files) in enumerate(source_before.items()):
  expected=dict(files);receipt_file=D/f'RELEASE-{j}.json'
  if receipt_file.exists() and json.loads(receipt_file.read_text()).get('success'):
   expected.update({x['path']:x['after_sha256'] for x in manifest if x['pool']==root})
  for p,h in expected.items():assert sha(Path(root)/p)==h,'source drift since exact-pool tests: '+p
 s=service(I);assert s['pid']>0 and s['status'] in ('online','active');assert Path('/proc/'+str(s['pid'])+'/cwd').resolve()==R
 # Fail before backups/source writes/restart if the actual probe cannot run.
 # Gray guard is already read-only; main probe validates schema/env read-only.
 preflight=subprocess.run(probe_args()+['--preflight'],cwd=R,env=probe_environment(s['pid']),capture_output=True,text=True,timeout=30)
 assert preflight.returncode==0,'probe preflight failed before source mutation; no restart performed'
 preflight_summary=json.loads(preflight.stdout);assert preflight_summary['pass']
 guard_args=['/usr/bin/node']+(['--env-file=.env.local'] if I==0 else [])+[str(D/'live-health-auth.mjs')]
 guard=subprocess.run(guard_args,cwd=R,env=probe_environment(s['pid']),capture_output=True,text=True,timeout=30)
 assert guard.returncode==0,'health/auth guard failed before mutation'
 write(D/f'GUARD-PRE-{I}.json',json.loads(guard.stdout))
 bound=bindings();policy_before=policies()
 time_state=subprocess.check_output(['timedatectl','show','-p','NTPSynchronized','-p','Timezone'],text=True);assert 'NTPSynchronized=yes' in time_state
 idle_state=idle();pre={'pool':I,'source':s,'idle':idle_state,'node':proof['node'],'ntp':time_state,'probe_preflight':preflight_summary,'manifest_sha256':sha(D/'candidate/MANIFEST.json')}
 if not APPLY:print(json.dumps({'dry_run':True,**pre}));sys.exit(0)
 receipt_path=D/f'RELEASE-{I}.json';assert not receipt_path.exists(),'prior pool receipt: inspect before action'
 bdir=D/f'backup-{I}-{int(time.time()*1000)}';bdir.mkdir(mode=0o700);modes={}
 for n,row in enumerate(rows):
  p=R/row['path'];modes[row['path']]=p.stat().st_mode&0o777 if p.exists() else 0o644
  if p.exists():shutil.copy2(p,bdir/str(n));assert sha(bdir/str(n))==row['before_sha256']
 write(bdir/'MANIFEST.json',{'rows':rows,'modes':modes,'pre':pre})
 envfiles=[Path(root)/n for root in ROOTS for n in ['.env.local','canary.env'] if (Path(root)/n).exists()];envhashes={str(p):sha(p) for p in envfiles};before_pm2=pm2();before_services=[service(i) for i in range(3)]
 receipt={'started_ms':int(time.time()*1000),'pool':I,'success':False,'pre':pre,'backup':str(bdir),'database_restore':False,'before_services':before_services}
 write(receipt_path,receipt);applied=[]
 try:
  for row in rows:
   p=R/row['path'];assert sha(p)==row['before_sha256'],'concurrent target drift';atomic(p,(D/'candidate'/str(I)/row['path']).read_bytes(),modes[row['path']]);applied.append(row)
  restart();current=service(I)
  env=probe_environment(current['pid']);args=probe_args()
  with (D/f'PROBE-{I}.private.log').open('wb') as f:r=subprocess.run(args,cwd=R,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=200)
  assert r.returncode==0,'actual HTTP probe failed; inspect private result'
  probe=json.loads((D/f'PROBE-{I}.json').read_text());assert probe['pass'] and probe['cleanup']
  guard=subprocess.run(guard_args,cwd=R,env=env,capture_output=True,text=True,timeout=30)
  assert guard.returncode==0,'post-release auth guard failed'
  write(D/f'GUARD-POST-{I}.json',json.loads(guard.stdout))
  for row in rows:assert sha(R/row['path'])==row['after_sha256'],'after source mismatch'
  assert all(sha(Path(p))==h for p,h in envhashes.items()),'environment changed';assert bindings()==bound,'device bindings changed';assert policies()==policy_before,'search/listening policy changed'
  after_pm2=pm2();assert {k:v for k,v in after_pm2.items() if not(I==0 and k=='p003-voice')}=={k:v for k,v in before_pm2.items() if not(I==0 and k=='p003-voice')},'unrelated PM2 change'
  after_services=[service(i) for i in range(3)];assert all(after_services[i]==before_services[i] for i in range(3) if i!=I),'unrelated Brain change'
  receipt.update(success=True,after_services=after_services,probe_sha256=sha(D/f'PROBE-{I}.json'),environment_unchanged=True,bindings_unchanged=True,policies_unchanged=True)
 except BaseException as e:
  receipt['error_type']=type(e).__name__;receipt['error']=str(e)[:160]
  assert all(sha(R/x['path'])==x['after_sha256'] for x in applied),'foreign drift prevents automatic rollback'
  for n,row in enumerate(rows):
   if row not in applied:continue
   p=R/row['path']
   if row['before_sha256'] is None:p.unlink()
   else:atomic(p,(bdir/str(n)).read_bytes(),modes[row['path']])
  if applied:restart()
  receipt['rolled_back']=True
  receipt['rollback_hashes_verified']=all(sha(R/x['path'])==x['before_sha256'] for x in rows)
  assert receipt['rollback_hashes_verified'] and health(),'rollback verification failed'
  guard=subprocess.run(guard_args,cwd=R,env=probe_environment(service(I)['pid']),capture_output=True,text=True,timeout=30)
  receipt['rollback_auth_health_pass']=guard.returncode==0
  assert guard.returncode==0,'rollback auth guard failed'
  raise
 finally:
  receipt['finished_ms']=int(time.time()*1000);write(receipt_path,receipt);print(json.dumps(receipt))
