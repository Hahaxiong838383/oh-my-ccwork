"""Exact two-source summary release. Keeps env, data, grants and other services intact."""
from pathlib import Path
import hashlib,json,subprocess,os,tempfile,time,shutil,fcntl,sys
D=Path('/root/p003-records-summary-20261116');R=Path('/opt/p003/server')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def processes():
 return {p['name']:{'pid':p['pid'],'status':p['pm2_env']['status'],'restarts':p['pm2_env']['restart_time']} for p in json.loads(subprocess.check_output(['pm2','jlist']))}
def copy(src,dst):
 fd,n=tempfile.mkstemp(prefix='.summary-',dir=dst.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(src.read_bytes());f.flush();os.fsync(f.fileno())
  os.chmod(n,0o644);os.replace(n,dst)
 finally:
  if os.path.exists(n):os.unlink(n)
def restart():
 subprocess.run(['pm2','restart','p003-voice'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30)
 for _ in range(40):
  time.sleep(.5)
  try:
   h=json.loads(subprocess.check_output(['curl','-sf','--max-time','2','http://127.0.0.1:3001/health'],stderr=subprocess.DEVNULL))
   if h.get('status')=='ok' and processes()['p003-voice']['status']=='online':return
  except (subprocess.CalledProcessError,ValueError):pass
 raise RuntimeError('health failed')
with (D/'release.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 m=json.loads((D/'MANIFEST.json').read_text());rows=m['files']
 assert {x['path'] for x in rows}=={'src/ark/records-contract.ts','src/ark/records-store.ts'}
 for x in rows:
  assert sha(R/x['path'])==x['before_sha256'],'production drift'
  assert sha(D/'candidate'/x['path'])==x['after_sha256'],'candidate drift'
 if '--apply' not in sys.argv:
  print(json.dumps({'dry_run':True,'files':len(rows),'pass':True}));sys.exit(0)
 assert not (D/'RELEASE.json').exists(),'previous release exists'
 tests=json.loads((D/'NODE22-TESTS.json').read_text());assert tests['pass'] and tests['manifest_sha256']==sha(D/'MANIFEST.json')
 reviewed=json.loads((D/'REVIEWED.json').read_text());assert reviewed['pass'] and reviewed['manifest_sha256']==sha(D/'MANIFEST.json')
 probe=json.loads((D/'PRE-RELEASE-PROBE.json').read_text())
 assert probe['room_check']['idle'] and 0<=time.time()*1000-probe['room_check']['at_ms']<60000,'fresh idle check required'
 before=processes();envsha=sha(R/'.env.local')
 assert before['p003-voice']['status']=='online'
 backup=D/'source-backup';backup.mkdir(exist_ok=False)
 for x in rows:
  dst=backup/x['path'];dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(R/x['path'],dst)
  assert sha(dst)==x['before_sha256']
 receipt={'started_ms':int(time.time()*1000),'success':False,'manifest_sha256':sha(D/'MANIFEST.json'),'backup':str(backup),'before':before['p003-voice']}
 try:
  for x in rows:
   assert sha(R/x['path'])==x['before_sha256'],'concurrent source drift'
   copy(D/'candidate'/x['path'],R/x['path'])
  restart()
  after=processes()
  assert sha(R/'.env.local')==envsha
  assert {k:v for k,v in before.items() if k!='p003-voice'}=={k:v for k,v in after.items() if k!='p003-voice'}
  assert after['p003-voice']['restarts']==before['p003-voice']['restarts']+1
  for x in rows:assert sha(R/x['path'])==x['after_sha256']
  receipt.update(success=True,after=after['p003-voice'],env_unchanged=True,other_processes_unchanged=True,files=2,database_restore=False)
 except BaseException as e:
  receipt['error_type']=type(e).__name__
  for x in rows:
   assert sha(R/x['path']) in (x['before_sha256'],x['after_sha256']),'foreign rollback drift'
  for x in rows:copy(backup/x['path'],R/x['path'])
  restart();receipt['rolled_back']=True
  raise
 finally:
  receipt['finished_ms']=int(time.time()*1000);(D/'RELEASE.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
