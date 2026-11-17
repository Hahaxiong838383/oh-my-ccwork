from pathlib import Path
import os,fcntl,json,hashlib,subprocess,time,urllib.request,urllib.error
D=Path('/opt/p003/onboarding-release-20261117');E=Path('/opt/p003/server/.env.local');KEY='VOICE_ONBOARDING_WORKER_ACCOUNTS'
os.umask(0o077)
def sha(b):return hashlib.sha256(b).hexdigest()
def atom(p,b):
 t=p.with_name(p.name+'.identity.tmp');fd=os.open(t,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 try:
  with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
  os.replace(t,p)
 finally:
  if t.exists():t.unlink()
def pm():return {x['name']:{'pid':x['pid'],'status':x['pm2_env']['status'],'restarts':x['pm2_env']['restart_time']}for x in json.loads(subprocess.check_output(['pm2','jlist'],text=True))}
def restart():
 r=subprocess.run(['pm2','restart','p003-voice'],text=True,capture_output=True,timeout=35);assert r.returncode==0
 for _ in range(40):
  time.sleep(.5)
  try:
   with urllib.request.urlopen('http://127.0.0.1:3001/health',timeout=2)as q:
    if q.status==200 and pm()['p003-voice']['pid']!=before_pm['p003-voice']['pid']:return pm()
  except OSError:pass
 raise RuntimeError('brain restart health failed')
lock=E.with_name(E.name+'.config.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
before=E.read_bytes();assert before==(D/'brain-before/env').read_bytes(),'environment drift'
env={}
for line in before.decode().splitlines():
 k,s,v=line.partition('=')
 if s:env[k]=v.strip().strip('"').strip("'")
assert KEY not in env
assert env['ARK_WORKER_ACCOUNT_ID']==env['SEARCH_WORKER_ACCOUNT_ID'] and env['ARK_WORKER_ACCOUNT_ID'].startswith('device-BJP003')
assert env.get('VOICE_ONBOARDING_ENABLED','0')!='1' and env.get('VOICE_ONBOARDING_V2_ENABLED','0')!='1'
# Configure exactly the service identity already trusted by Search and Ark. No wildcard and no JWT changes.
value=env['ARK_WORKER_ACCOUNT_ID'];after=before+(b''if before.endswith(b'\n')else b'\n')+(KEY+'='+value+'\n').encode()
assert KEY.encode()not in before
before_pm=pm();assert before_pm['p003-voice']['pid']==2341004
root=Path('/opt/p003/server');source_before={str(p.relative_to(root)):sha(p.read_bytes()) for p in (root/'src').rglob('*') if p.is_file()}
backup=D/'brain-service-identity-before.env';assert not backup.exists();atom(backup,before)
result={'before_env_sha256':sha(before),'after_env_sha256':sha(after),'key':KEY,'value_sha256':sha(value.encode()),'existing_search_and_ark_identity_equal':True,'identity_count':1,'gates_enabled':False,'started_ms':int(time.time()*1000),'before_pm':before_pm,'backup':str(backup)}
try:
 assert E.read_bytes()==before and pm()==before_pm
 atom(E,after);post=restart();assert E.read_bytes()==after;assert {k:v for k,v in post.items()if k!='p003-voice'}=={k:v for k,v in before_pm.items()if k!='p003-voice'}
 assert {str(p.relative_to(root)):sha(p.read_bytes()) for p in (root/'src').rglob('*') if p.is_file()}==source_before,'source changed during config-only restart'
 result.update(success=True,after_pm=post,all_source_unchanged=True)
except BaseException as ex:
 result.update(success=False,error_type=type(ex).__name__)
 if E.read_bytes()==after:atom(E,before);result['rollback_pm']=restart()
 raise
finally:
 result['finished_ms']=int(time.time()*1000);atom(D/'SERVICE-IDENTITY-RELEASE.json',json.dumps(result,indent=2).encode());print(json.dumps(result))
