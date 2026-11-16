from pathlib import Path
import json,hashlib,subprocess,os,tempfile,time,fcntl,sqlite3
os.umask(0o077);D=Path('/root/p003-records-r1-20261116');P=D/'release-997fe832';R=Path('/opt/p003/server');E=R/'.env.local';B=D/'before-production';m=json.loads((P/'MANIFEST.json').read_text());before=json.loads((D/'BEFORE-PRODUCTION.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
get=lambda:json.loads(subprocess.check_output(['pm2','jlist']))
def processes():return {p['name']:{'pid':p['pid'],'status':p['pm2_env']['status'],'restarts':p['pm2_env']['restart_time']} for p in get()}
def atomic(path,data):
 fd,n=tempfile.mkstemp(prefix='.r1-env-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(n,0o600);os.replace(n,path)
 finally:
  if os.path.exists(n):os.unlink(n)
def restart():
 subprocess.run(['pm2','restart','p003-voice'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30)
 for _ in range(40):
  time.sleep(.5)
  try:
   health=json.loads(subprocess.check_output(['curl','-sf','--max-time','2','http://127.0.0.1:3001/health'],stderr=subprocess.DEVNULL));p=processes()['p003-voice']
   if health.get('status')=='ok' and p['status']=='online':return p
  except (subprocess.CalledProcessError,ValueError):pass
 raise RuntimeError('restart health verification failed')
cmd=['python3',str(P/'records-release-files.py'),'--package',str(P),'--root',str(R),'--backup',str(D/'six-source-backup')]
receipt={'candidate':m['candidate'],'sn':'BJP00326081002000031','started_ms':int(time.time()*1000),'success':False}
with (D/'production.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 assert not (D/'PRODUCTION-RELEASE.json').exists(),'prior attempt exists'
 reviewed=json.loads((D/'REVIEWED.json').read_text());assert reviewed['candidate']==m['candidate'] and reviewed['pass'] is True
 idle=json.loads((D/'ROOM-IDLE-FINAL.json').read_text());assert idle['idle'] and 0<=time.time()*1000-idle['at_ms']<60000,'fresh idle evidence required'
 db=sqlite3.connect('file:/opt/p003/server/data/devices.db?mode=ro',uri=True);c=db.execute('SELECT status,parent_account_id,e.epoch FROM device_registry d JOIN ark_device_epoch e ON d.sn=e.sn WHERE d.sn=?',('BJP00326081002000031',)).fetchone();db.close()
 assert c and c[0]=='active' and c[2]==2 and hashlib.sha256(c[1].encode()).hexdigest()=='00106543b465be2fe79b80a2ad873dc4471e1dac91af2213cfec78a9e8bdc0da'
 old=E.read_bytes();assert sha(E)==before['env_before_sha256']==sha(B/'env.local')
 assert old.endswith(b'\n');assert not any(x.strip().startswith((b'ARK_RECORDS_SN_ALLOW=',b'export ARK_RECORDS_SN_ALLOW=')) for x in old.splitlines())
 oldp=processes();assert oldp['p003-voice']['pid']==before['voice_before']['pid'];assert oldp['p003-voice']['status']=='online'
 for name,h in m['required_unchanged_dependencies'].items():assert sha(R/name)==h,name
 subprocess.run(cmd,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 new=old+b'ARK_RECORDS_SN_ALLOW=BJP00326081002000031\n';installed=False;env_written=False
 try:
  subprocess.run(cmd+['--apply'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE);installed=True
  assert E.read_bytes()==old,'env changed during release';atomic(E,new);env_written=True
  after=restart();assert after['pid']!=oldp['p003-voice']['pid'] and after['restarts']==oldp['p003-voice']['restarts']+1
  assert E.read_bytes()==new
  for row in m['files']:assert sha(R/row['path'])==row['after_sha256'],row['path']
  for name,h in m['required_unchanged_dependencies'].items():assert sha(R/name)==h,name
  current=processes();assert {k:v for k,v in current.items() if k!='p003-voice'}=={k:v for k,v in oldp.items() if k!='p003-voice'}
  receipt.update(success=True,before=oldp['p003-voice'],after=after,env_after_sha256=sha(E),files=6,records_scope=['BJP00326081002000031'],other_processes_unchanged=True,backup=str(B),source_backup=str(D/'six-source-backup'))
 except BaseException as e:
  receipt['error_type']=type(e).__name__
  try:
   # Only remove our exact added line; preserve later unrelated credential edits.
   if env_written:
    current=E.read_bytes();line=b'ARK_RECORDS_SN_ALLOW=BJP00326081002000031\n';assert current.splitlines().count(line.rstrip(b'\n'))==1
    atomic(E,current.replace(line,b''))
   if installed or (D/'six-source-backup'/'RELEASE.json').exists():subprocess.run(cmd+['--rollback','--apply'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   receipt['rollback_process']=restart();receipt['rolled_back']=True
  except BaseException as recovery:receipt['rollback_error_type']=type(recovery).__name__
  raise
 finally:
  receipt['finished_ms']=int(time.time()*1000);(D/'PRODUCTION-RELEASE.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
