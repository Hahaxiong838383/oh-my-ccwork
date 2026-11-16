"""Publish the frozen compatibility candidate, enable only C, verify; never restore business databases."""
from pathlib import Path
import hashlib,json,os,subprocess,tempfile,time,shutil,fcntl,sqlite3,sys
D=Path('/root/p003-records-compat-20261116');R=Path('/opt/p003/server')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def atomic(data,path,mode=0o644):
 fd,tmp=tempfile.mkstemp(prefix='.records-compat-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(tmp,mode);os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def processes():
 return {p['name']:{'pid':p['pid'],'status':p['pm2_env']['status'],'restarts':p['pm2_env']['restart_time']} for p in json.loads(subprocess.check_output(['pm2','jlist']))}
def restart():
 subprocess.run(['pm2','restart','p003-voice'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30)
 for _ in range(50):
  time.sleep(.4)
  try:
   data=json.loads(subprocess.check_output(['curl','-sf','--max-time','2','http://127.0.0.1:3001/health'],stderr=subprocess.DEVNULL))
   if data.get('status')=='ok' and processes()['p003-voice']['status']=='online':return
  except (subprocess.CalledProcessError,ValueError):pass
 raise RuntimeError('health failed')
def config(action):
 p=subprocess.run(['node','--env-file=.env.local','--import','tsx',str(D/'config-enable.mjs'),action],cwd=R,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 return json.loads(p.stdout)
def check_scope(scope):
 db=sqlite3.connect('file:/opt/p003/server/data/devices.db?mode=ro',uri=True);db.row_factory=sqlite3.Row
 row=dict(db.execute('SELECT d.sn,d.public_id,d.account_id,d.parent_account_id,d.binding_version,e.epoch FROM device_registry d JOIN ark_device_epoch e ON e.sn=d.sn WHERE d.sn=? AND d.status=?',(scope['sn'],'active')).fetchone())
 assert all(scope[k]==v for k,v in row.items()),'current binding changed'
 assert db.execute('SELECT COUNT(*) FROM device_registry WHERE account_id=?',(scope['account_id'],)).fetchone()[0]==1
 db.close()
 db=sqlite3.connect('file:/opt/p003/server/data/ark.db?mode=ro',uri=True)
 assert db.execute('SELECT grant_id FROM ark_grant WHERE sn=? AND account_id=? AND epoch=?',(scope['sn'],scope['account_id'],scope['epoch'])).fetchone()[0]==scope['grant_id']
 db.close()
with (D/'release.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 manifest=json.loads((D/'MANIFEST.json').read_text());rows=manifest['files'];pre=json.loads((D/'PREFLIGHT.json').read_text())
 expected={'src/ark/records-legacy.ts','src/ark/records-store.ts','src/ark/records-routes.ts','src/ark/records-contract.ts','src/ark/records-service.ts','src/config-store.ts','src/routes/device-config.ts'}
 assert {r['path'] for r in rows}==expected
 for row in rows:
  assert sha(R/row['path'])==row['before_sha256'],'production source drift'
  assert sha(D/'candidate'/row['path'])==row['after_sha256'],'candidate source drift'
 env=R/'.env.local';assert sha(env)==pre['env_sha256'],'production environment drift'
 scope=json.loads((D/'scope-private.json').read_text());assert sha(D/'scope-private.json')==pre['scope_sha256'];check_scope(scope)
 oldenv=env.read_bytes();assert b'ARK_RECORDS_LEGACY_SCOPE_JSON=' not in oldenv
 newenv=oldenv+b'\nARK_RECORDS_LEGACY_SCOPE_JSON='+json.dumps(scope,separators=(',',':')).encode()+b'\n'
 tests=json.loads((D/'NODE22-TESTS.json').read_text());assert tests['pass'] and tests['manifest_sha256']==sha(D/'MANIFEST.json')
 review=json.loads((D/'REVIEWED.json').read_text());assert review['pass'] and review['manifest_sha256']==sha(D/'MANIFEST.json')
 if '--apply' not in sys.argv:print(json.dumps({'dry_run':True,'files':len(rows),'single_C_only':True,'pass':True}));sys.exit(0)
 assert not (D/'RELEASE.json').exists(),'previous release receipt exists'
 idle=json.loads((D/'PRE-RELEASE-READONLY.json').read_text())['room_check']
 assert idle['verified'] and idle['idle'] and 0<=time.time()*1000-idle['at_ms']<60000,'fresh idle check required'
 before=processes();assert before['p003-voice']['status']=='online'
 backup=D/'source-backup';backup.mkdir(mode=0o700)
 for row in rows:
  if row['before_sha256'] is not None:
   target=backup/row['path'];target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(R/row['path'],target)
 atomic(oldenv,backup/'env.private',0o600)
 # Consistent private backups for inspection only; rollback never overwrites received facts.
 for name in ['config','ark']:
  source=sqlite3.connect('file:'+str(R/'data'/f'{name}.db')+'?mode=ro',uri=True);target=sqlite3.connect(backup/f'{name}.db');source.backup(target);source.close();target.close();os.chmod(backup/f'{name}.db',0o600)
 receipt={'started_ms':int(time.time()*1000),'success':False,'manifest_sha256':sha(D/'MANIFEST.json'),'backup':str(backup),'before':before['p003-voice'],'files':len(rows),'database_restore':False}
 try:
  for row in rows:
   assert sha(R/row['path'])==row['before_sha256'],'concurrent source drift';atomic((D/'candidate'/row['path']).read_bytes(),R/row['path'])
  assert env.read_bytes()==oldenv,'concurrent environment drift';atomic(newenv,env,env.stat().st_mode&0o777)
  receipt['config']=config('enable');restart()
  after=processes();assert {k:v for k,v in before.items() if k!='p003-voice'}=={k:v for k,v in after.items() if k!='p003-voice'}
  assert after['p003-voice']['restarts']==before['p003-voice']['restarts']+1
  for row in rows:assert sha(R/row['path'])==row['after_sha256']
  assert env.read_bytes()==newenv;check_scope(scope)
  subprocess.run(['node','--env-file=.env.local',str(D/'probe.mjs')],cwd=R,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=60)
  post=json.loads((D/'POST-RELEASE-PROBE.json').read_text());assert post['pass']
  receipt.update(success=True,after=after['p003-voice'],other_processes_unchanged=True,single_C_upload_enabled=True,real_device_upload_verified=post['real_device_upload_verified'])
 except BaseException as error:
  receipt['error_type']=type(error).__name__
  try:receipt['rollback_config']=config('disable')
  except BaseException:receipt['rollback_config_failed']=True
  for row in rows:assert sha(R/row['path']) in (row['before_sha256'],row['after_sha256']),'foreign rollback drift'
  assert env.read_bytes() in (oldenv,newenv),'foreign environment rollback drift'
  for row in rows:
   if row['before_sha256'] is None:(R/row['path']).unlink(missing_ok=True)
   else:atomic((backup/row['path']).read_bytes(),R/row['path'])
  atomic(oldenv,env,env.stat().st_mode&0o777);restart();receipt['rolled_back']=True
  raise
 finally:
  receipt['finished_ms']=int(time.time()*1000);(D/'RELEASE.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
