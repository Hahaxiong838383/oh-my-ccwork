"""Deploy two verified sources and the single-C history scope; no database mutation."""
from pathlib import Path
import hashlib,json,subprocess,os,tempfile,time,shutil,fcntl,sys,sqlite3
D=Path('/root/p003-parent-history-20261116');R=Path('/opt/p003/server')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def processes():
 return {p['name']:{'pid':p['pid'],'status':p['pm2_env']['status'],'restarts':p['pm2_env']['restart_time']} for p in json.loads(subprocess.check_output(['pm2','jlist']))}
def atomic(data,dst,mode=0o644):
 fd,n=tempfile.mkstemp(prefix='.history-',dir=dst.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(n,mode);os.replace(n,dst)
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
 m=json.loads((D/'MANIFEST.json').read_text());rows=m['files'];pre=json.loads((D/'PREFLIGHT.json').read_text())
 assert {x['path'] for x in rows}=={'src/routes/telemetry.ts','src/parent-conversations.ts'}
 for x in rows:
  assert sha(R/x['path'])==x['before_sha256'],'production drift'
  assert sha(D/'candidate'/x['path'])==x['after_sha256'],'candidate drift'
 env=R/'.env.local';assert sha(env)==pre['env_sha256'],'environment drift'
 for p in ['src/ark/records-contract.ts','src/ark/records-store.ts']:assert sha(R/p)==pre['files'][p],'summary drift'
 assert sha(D/'scope-private.json')==pre['scope_sha256']
 scope=json.loads((D/'scope-private.json').read_text())
 db=sqlite3.connect('file:/opt/p003/server/data/devices.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
 current=dict(db.execute('SELECT d.public_id,d.sn,d.parent_account_id,d.account_id,d.binding_version,e.epoch FROM device_registry d JOIN ark_device_epoch e ON e.sn=d.sn WHERE d.sn=? AND d.status=?',(scope['sn'],'active')).fetchone())
 assert current==scope,'binding drift'
 assert db.execute('SELECT COUNT(*) FROM device_registry WHERE account_id=?',(scope['account_id'],)).fetchone()[0]==1
 db.close()
 oldenv=env.read_bytes();assert b'PARENT_CONVERSATION_SCOPE_JSON' not in oldenv
 newenv=oldenv+b'\nPARENT_CONVERSATION_SCOPE_JSON='+json.dumps(scope,separators=(',',':')).encode()+b'\n'
 if '--apply' not in sys.argv:
  print(json.dumps({'dry_run':True,'files':2,'single_device_scope':True,'pass':True}));sys.exit(0)
 assert not (D/'RELEASE.json').exists(),'previous release exists'
 for name in ['NODE22-TESTS.json','REVIEWED.json']:
  check=json.loads((D/name).read_text());assert check['pass'] and check['manifest_sha256']==sha(D/'MANIFEST.json')
 probe=json.loads((D/'PRE-RELEASE-PROBE.json').read_text())
 assert probe['room_check']['idle'] and 0<=time.time()*1000-probe['room_check']['at_ms']<60000,'fresh idle check required'
 before=processes();assert before['p003-voice']['status']=='online'
 backup=D/'source-backup';backup.mkdir(mode=0o700,exist_ok=False)
 for x in rows:
  if x['before_sha256'] is not None:
   dst=backup/x['path'];dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(R/x['path'],dst)
   assert sha(dst)==x['before_sha256']
 atomic(oldenv,backup/'env.private',0o600)
 receipt={'started_ms':int(time.time()*1000),'success':False,'manifest_sha256':sha(D/'MANIFEST.json'),'backup':str(backup),'before':before['p003-voice']}
 try:
  for x in rows:
   assert sha(R/x['path'])==x['before_sha256'],'concurrent source drift'
   atomic((D/'candidate'/x['path']).read_bytes(),R/x['path'])
  assert env.read_bytes()==oldenv,'concurrent env drift'
  atomic(newenv,env,env.stat().st_mode&0o777)
  restart();after=processes()
  assert env.read_bytes()==newenv
  assert {k:v for k,v in before.items() if k!='p003-voice'}=={k:v for k,v in after.items() if k!='p003-voice'}
  assert after['p003-voice']['restarts']==before['p003-voice']['restarts']+1
  for x in rows:assert sha(R/x['path'])==x['after_sha256']
  subprocess.run(['node','--env-file=.env.local',str(D/'probe.mjs'),str(D/'POST-RELEASE-PROBE.json')],cwd=R,check=True,stdout=subprocess.DEVNULL,timeout=60)
  post=json.loads((D/'POST-RELEASE-PROBE.json').read_text())
  for item in post['results']:
   assert item['history_status']==200 and item['exact_db_match'] and item['wrong_owner_status']==404 and item['cache']=='no-store'
  receipt.update(success=True,after=after['p003-voice'],scope_only_environment_change=True,other_processes_unchanged=True,files=2,database_restore=False)
 except BaseException as e:
  receipt['error_type']=type(e).__name__
  for x in rows:assert sha(R/x['path']) in (x['before_sha256'],x['after_sha256']),'foreign rollback drift'
  assert env.read_bytes() in (oldenv,newenv),'foreign env rollback drift'
  for x in rows:
   if x['before_sha256'] is None:(R/x['path']).unlink(missing_ok=True)
   else:atomic((backup/x['path']).read_bytes(),R/x['path'])
  atomic(oldenv,env,env.stat().st_mode&0o777);restart();receipt['rolled_back']=True
  raise
 finally:
  receipt['finished_ms']=int(time.time()*1000);(D/'RELEASE.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
