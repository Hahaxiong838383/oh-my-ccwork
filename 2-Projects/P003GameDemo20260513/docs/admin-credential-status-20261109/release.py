import os,json,hashlib,shutil,subprocess,tempfile,datetime,fcntl,sys,urllib.request,sqlite3,time
from pathlib import Path
os.umask(0o077)
STAGE=Path('/opt/p003/_staging/admin-credential-view-97f13f08')
manifest_path=Path(sys.argv[2])/'manifest.json' if len(sys.argv)>2 and sys.argv[1]=='--rollback' else STAGE/'manifest.json'
manifest=json.loads(manifest_path.read_text());files=manifest['files']
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
def check(mode):
 for f in files:
  if digest(Path(f['target']))!=f[mode]:raise RuntimeError('file drift: '+f['target'])
def replace(source,target):
 target=Path(target);fd,tmp=tempfile.mkstemp(prefix='.admin-view-',dir=target.parent)
 try:
  with os.fdopen(fd,'wb') as out:out.write(Path(source).read_bytes());out.flush();os.fsync(out.fileno())
  os.chmod(tmp,0o644);os.replace(tmp,target)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
def restore(backup):
 # Refuse concurrent changes, and do not touch any DB, environment file or device state.
 for f in files:
  if digest(Path(f['target'])) not in (f['before'],f['after']):raise RuntimeError('rollback refused: concurrent file drift')
 for i,f in enumerate(files):
  if digest(Path(f['target']))==f['before']:continue
  if f['before'] is None:Path(f['target']).unlink()
  else:replace(backup/('file-'+str(i)),f['target'])
 check('before')
 r=subprocess.run(['pm2','restart','p003-voice'],capture_output=True,timeout=35)
 if r.returncode:raise RuntimeError('rollback restart failed')
 return {'restored':True,'backup':str(backup)}
if len(sys.argv)>1 and sys.argv[1]=='--rollback':
 print(json.dumps(restore(Path(sys.argv[2]))));raise SystemExit(0)
lock=open('/opt/p003/_backup/.admin-credential-view.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
check('before')
# Read only existing server-managed admin credentials; never print or persist credentials/tokens.
env={}
for line in Path('/opt/p003/server/.env.local').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k,v=line.split('=',1);env[k.strip()]=v.strip().strip('"').strip("'")
def req(path,body=None,token=None):
 r=urllib.request.Request('http://127.0.0.1:3001'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})})
 with urllib.request.urlopen(r,timeout=35) as response:return json.load(response)
login=req('/api/auth/login',{'username':env['STUDIO_USER'],'password':env['STUDIO_PASS']});token=login['token']
rooms=req('/api/admin/worker-stats',token=token).get('rooms');assert rooms is not None and rooms['total_rooms']==0,'active room or unknown room state; defer restart'
def state_hashes():
 result={}
 for dbname,tables in [('devices',['device_registry','device_identity_key','ble_binding_challenge','ble_binding_receipt','device_credential_revocation']),('pairing',['pairing_session'])]:
  f=Path(env.get(dbname.upper()+'_DB_PATH') or '/opt/p003/server/data/'+dbname+'.db');f=f if f.is_absolute() else Path('/opt/p003/server')/f
  db=sqlite3.connect('file:'+str(f)+'?mode=ro',uri=True);db.execute('PRAGMA query_only=ON')
  for t in tables:result[dbname+'.'+t]=hashlib.sha256(json.dumps(db.execute('SELECT * FROM '+t+' ORDER BY rowid').fetchall(),sort_keys=True).encode()).hexdigest()
  db.close()
 return result
core_expected={'/opt/p003/server/src/ble-binding-store.ts': 'b10d9c3c301d064fca3949cb7f79a21133f5f6852a651458f075047c0ba4c07f', '/opt/p003/server/src/device-credential.ts': 'c3ba47f768c6f1e61cc540e3271f603ad07eb8ac9b2c3ecb3b237f93b792d038', '/opt/p003/server/src/routes/pairing.ts': 'ccb89ef6547d77a87309d05b8818004713829719facbdda467f534e68d1cc8e5', '/opt/p003/server/src/routes/ble-bindings.ts': '6a58a928aecd039d356caf479f6819be0ee2fab1696dfef94398831aab3316ff'}
assert all(digest(Path(k))==v for k,v in core_expected.items()),'binding/issuer/auth source changed since baseline'
state_before=state_hashes();assert isinstance(state_before,dict) and len(state_before)==6
api_before=req('/api/admin/devices',token=token)
check('before')
backup=Path('/opt/p003/_backup/admin-credential-view-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for i,f in enumerate(files):
 if f['before'] is not None:shutil.copy2(f['target'],backup/('file-'+str(i)))
shutil.copy2(STAGE/'manifest.json',backup/'manifest.json');shutil.copy2(STAGE/'release.py',backup/'release.py')
(backup/'state-before.json').write_text(json.dumps(state_before));(backup/'api-before.json').write_text(json.dumps(api_before))
check('before')
try:
 for f in files:
  source=STAGE/'candidate'/f['relative'];assert digest(source)==f['after'];replace(source,f['target'])
 check('after')
 r=subprocess.run(['pm2','restart','p003-voice'],capture_output=True,timeout=35)
 if r.returncode:
  raise RuntimeError('restart failed')
 health=None
 for i in range(20):
  try:
   health=req('/health')
   if health.get('status')=='ok':break
  except Exception:pass
  time.sleep(0.5)
 if not health or health.get('status')!='ok':
  raise RuntimeError('health failed')
 # In-memory admin sessions reset on process restart, so authenticate afresh.
 login=req('/api/auth/login',{'username':env['STUDIO_USER'],'password':env['STUDIO_PASS']});token=login['token'];api_after=req('/api/admin/devices',token=token)
 old={d['sn']:d for d in api_before['devices']};new={d['sn']:d for d in api_after['devices']}
 assert old.keys()==new.keys(),'device set drift'
 original_diffs={}
 for sn,d in new.items():
  v={k:x for k,x in d.items() if k!='ble_status'}
  if v!=old[sn]:original_diffs[sn[-8:]]=[k for k in set(v)|set(old[sn]) if v.get(k)!=old[sn].get(k)]
 c=[d for d in api_after['devices'] if d['sn'].endswith('02000031')][0]
 assert c['ble_status']['state']=='available' and c['ble_status']['issued_at_ms'] and c['ble_status']['pairing']['state']=='claim_expired'
 state_after=state_hashes()
 processes=[]
 for x in json.loads(subprocess.check_output(['pm2','jlist'])):
  e=x['pm2_env'];processes.append({'name':x['name'],'pid':x['pid'],'status':e['status'],'uptime':e['pm_uptime'],'restarts':e['restart_time']})
 result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidate':manifest['sha'],'backup':str(backup),'health':health,'rooms_before':rooms,'file_hashes':{f['target']:digest(Path(f['target'])) for f in files},'state_unchanged':state_before==state_after,'core_source_unchanged':all(digest(Path(k))==v for k,v in core_expected.items()),'state_hashes_before':state_before,'state_hashes_after':state_after,'original_api_field_diffs':original_diffs,'device_count':len(new),'c_ble_status':c['ble_status'],'processes':processes}
 (backup/'release-result.json').write_text(json.dumps(result,indent=2));(STAGE/'release-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
except Exception as error:
 restored=restore(backup)
 (backup/'verification-failure.json').write_text(json.dumps({'error_type':type(error).__name__,'rollback':restored}))
 raise
