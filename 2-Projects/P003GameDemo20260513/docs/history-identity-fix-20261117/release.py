"""Guarded incremental dashboard release. Source-only rollback; never restore business DBs."""
from pathlib import Path
import hashlib,json,os,subprocess,tempfile,time,shutil,fcntl,sqlite3,sys
D=Path('/root/p003-history-identity-fix-20261117');R=Path('/opt/p003/server')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None

def atomic(data,path,mode=0o644):
 fd,tmp=tempfile.mkstemp(prefix='.miniapp-admin-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(tmp,mode);os.replace(tmp,path)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def processes():
 return {p['name']:{'pid':p['pid'],'status':p['pm2_env']['status'],'restarts':p['pm2_env']['restart_time']} for p in json.loads(subprocess.check_output(['pm2','jlist']))}
def restart():
 subprocess.run(['pm2','restart','p003-analytics'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30)
 subprocess.run(['pm2','restart','p003-voice'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30)
 for _ in range(60):
  time.sleep(.5)
  try:
   data=json.loads(subprocess.check_output(['curl','-sf','--max-time','2','http://127.0.0.1:3001/health'],stderr=subprocess.DEVNULL))
   if data.get('status')=='ok' and processes()['p003-voice']['status']=='online':
    analytics=json.loads(subprocess.check_output(['curl','-sf','--max-time','2','http://127.0.0.1:3006/ready'],stderr=subprocess.DEVNULL))
    if analytics.get('ready') is True:return
  except (subprocess.CalledProcessError,ValueError):pass
 raise RuntimeError('health failed')
def binding_snapshot():
 with sqlite3.connect('file:'+str(R/'data/devices.db')+'?mode=ro',uri=True) as db:
  rows=db.execute('SELECT sn,public_id,account_id,parent_account_id,binding_version,status FROM device_registry ORDER BY sn').fetchall()
 return hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()
def pending_pairings():
 with sqlite3.connect('file:'+str(R/'data/pairing.db')+'?mode=ro',uri=True) as db:
  now=int(time.time()*1000)
  return {'active_preauth':db.execute('SELECT COUNT(*) FROM device_preauth WHERE used_at IS NULL AND until_at>?',(now,)).fetchone()[0],
   'pending_sessions':db.execute('SELECT COUNT(*) FROM pairing_session WHERE claimed_at IS NULL AND expires_at>?',(now,)).fetchone()[0]}
with (D/'release.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 manifest=json.loads((D/'MANIFEST.json').read_text());rows=manifest['files'];pre=json.loads((D/'PREFLIGHT.json').read_text())
 for row in rows:
  assert sha(Path(row['target']))==row['before_sha256'],'production source drift'
  assert sha(D/row['candidate'])==row['after_sha256'],'candidate source drift'
 assert sha(R/'.env.local')==pre['env_sha256'],'production voice environment drift'
 assert sha(R/'.env.analytics')==pre['analytics_env_sha256'],'production analytics environment drift'
 # Also protect files outside the deployment list: tested candidate includes current production base.
 targets={r['target'] for r in rows}
 for name,digest in pre['source_manifest'].items():
  if str(R/name) not in targets:assert sha(R/name)==digest,'unrelated production source drift'
 for name in ['NODE22-TESTS.json','REVIEWED.json']:
  proof=json.loads((D/name).read_text());assert proof['pass'] and proof['manifest_sha256']==sha(D/'MANIFEST.json'),name
 if '--apply' not in sys.argv:print(json.dumps({'dry_run':True,'pass':True,'files':len(rows),'pending':pending_pairings()}));sys.exit(0)
 assert not (D/'RELEASE.json').exists(),'previous release receipt exists'
 idle=json.loads((D/'PRE-RELEASE-READONLY.json').read_text())['room_check']
 assert idle['verified'] and idle['idle'] and 0<=time.time()*1000-idle['at_ms']<60000,'fresh idle check required'
 assert not any(pending_pairings().values()),'pairing in progress; retry later'
 before=processes();assert before['p003-voice']['status']=='online';bindings=binding_snapshot()
 backup=D/'source-backup';backup.mkdir(mode=0o700)
 for i,row in enumerate(rows):
  if row['before_sha256'] is not None:shutil.copy2(row['target'],backup/str(i))
 # Private consistent inspection backups; migration is additive and rollback never restores these.
 for name in ['accounts','devices','pairing']:
  source=sqlite3.connect('file:'+str(R/'data'/f'{name}.db')+'?mode=ro',uri=True);target=sqlite3.connect(backup/f'{name}.db');source.backup(target);source.close();target.close();os.chmod(backup/f'{name}.db',0o600)
 receipt={'started_ms':int(time.time()*1000),'success':False,'manifest_sha256':sha(D/'MANIFEST.json'),'before':{k:before[k] for k in ['p003-voice','p003-analytics']},'files':len(rows),'database_restore':False,'real_unbind_performed':False}
 try:
  for row in rows:
   assert sha(Path(row['target']))==row['before_sha256'],'concurrent source drift';atomic((D/row['candidate']).read_bytes(),Path(row['target']),row.get('mode',0o644))
  restart();after=processes()
  assert {k:v for k,v in before.items() if k not in ['p003-voice','p003-analytics']}=={k:v for k,v in after.items() if k not in ['p003-voice','p003-analytics']},'other process changed'
  for name in ['p003-voice','p003-analytics']:assert after[name]['restarts']==before[name]['restarts']+1
  for row in rows:assert sha(Path(row['target']))==row['after_sha256']
  assert binding_snapshot()==bindings,'binding changed during release'
  subprocess.run(['node','--env-file=.env.local',str(D/'probe.mjs')],cwd=R,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=100)
  assert json.loads((D/'POST-RELEASE-PROBE.json').read_text())['pass']
  receipt.update(success=True,after={k:after[k] for k in ['p003-voice','p003-analytics']},other_processes_unchanged=True,bindings_unchanged=True,environment_changes=['wechat_app_configuration','existing_C_history_scope_for_analytics'])
 except BaseException as error:
  receipt['error_type']=type(error).__name__
  for row in rows:assert sha(Path(row['target'])) in (row['before_sha256'],row['after_sha256']),'foreign rollback drift'
  for i,row in enumerate(rows):
   if row['before_sha256'] is None:Path(row['target']).unlink(missing_ok=True)
   else:atomic((backup/str(i)).read_bytes(),Path(row['target']),row.get('mode',0o644))
  restart();receipt['rolled_back']=True
  raise
 finally:
  receipt['finished_ms']=int(time.time()*1000);(D/'RELEASE.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
