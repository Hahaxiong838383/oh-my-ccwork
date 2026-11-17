from pathlib import Path
import fcntl,hashlib,json,os,sqlite3,subprocess,sys,time,urllib.request,urllib.error
os.umask(0o077)
D=Path('/opt/p003/onboarding-release-20261117');ROOT=Path('/opt/p003/server');ENV=ROOT/'.env.local';MAN=json.loads((D/'BRAIN-MANIFEST.json').read_text());ROWS=MAN['files']
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()if p.exists()else None
def atomic(p,b,mode=0o600):
 t=p.with_name(p.name+'.onboarding.tmp');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
 try:
  with os.fdopen(fd,'wb')as f:f.write(b);f.flush();os.fsync(f.fileno())
  os.replace(t,p)
 finally:
  if t.exists():t.unlink()
def pm():
 return {x['name']:{'pid':x['pid'],'status':x['pm2_env']['status'],'restarts':x['pm2_env']['restart_time'],'cwd':x['pm2_env']['pm_cwd']}for x in json.loads(subprocess.check_output(['pm2','jlist'],text=True))}
def snapshot():return {str(p.relative_to(ROOT)):sha(p)for p in(ROOT/'src').rglob('*')if p.is_file()}
def request(path,port,method='GET'):
 try:
  with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+str(port)+path,data=b'{}'if method=='POST'else None,method=method,headers={'content-type':'application/json'}),timeout=4)as r:return {'status':r.status,'body':json.load(r)}
 except urllib.error.HTTPError as r:return {'status':r.code,'body':json.loads(r.read())}
def main(mode):
 assert mode in ('check','apply','rollback');assert subprocess.check_output(['hostname'],text=True).strip()=='iZj6cher4yitk4sw7m38yyZ'
 lock=ENV.with_name(ENV.name+'.config.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 before=pm();assert before['p003-voice']['status']=='online'and before['p003-voice']['cwd']==str(ROOT)
 env={}
 for line in ENV.read_text().splitlines():
  k,sep,v=line.partition('=')
  if sep:env[k]=v.strip().strip('"').strip("'")
 assert env.get('VOICE_ONBOARDING_ENABLED','0')!='1'and env.get('VOICE_ONBOARDING_V2_ENABLED','0')!='1','close onboarding gates before binary/schema rollback'
 port=int(env.get('PORT','8787'));envsha=sha(ENV);others={k:v for k,v in before.items()if k!='p003-voice'}
 oldmap=snapshot();target={x['path']for x in ROWS}
 def unchanged():
  assert pm()==before and sha(ENV)==envsha and snapshot()==oldmap,'concurrent runtime/source/config drift'
 def check_files(which):
  for x in ROWS:assert sha(ROOT/x['path'])==x[which], 'source drift: '+x['path']
 def restart(new):
  r=subprocess.run(['pm2','restart','p003-voice'],capture_output=True,text=True,timeout=35);assert r.returncode==0,'pm2 restart failed'
  for _ in range(60):
   time.sleep(.5);p=pm()
   try:
    health=request('/health',port);ready=request('/ready',3006)
    route=request('/v1/internal/voice-onboarding/v2/step',port,'POST')if new else None
   except (OSError,ValueError):continue
   if p['p003-voice']['status']=='online'and p['p003-voice']['pid']!=before['p003-voice']['pid']and health['status']==200 and ready['status']==200 and (not new or route=={'status':403,'body':{'error':'worker_unauthorized','memory_write':'none'}}):
    return {'pm':p,'health':health,'analytics_ready':{'status':ready['status'],'ready':ready['body'].get('ready')},'unauthorized_route':route}
  raise RuntimeError('post restart health failed')
 check_files('after'if mode=='rollback'else'before');unchanged();assert request('/health',port)['status']==200 and request('/ready',3006)['status']==200
 if mode=='check':print(json.dumps({'check':True,'files':len(ROWS),'gates_off':True,'no_runtime_mutation':True,'port':port}));return
 backup=D/'brain-before';receipt=D/'BRAIN-RELEASE.json'
 def restore():
  for x in ROWS:
   p=ROOT/x['path'];assert sha(p)in (x['before'],x['after']),'rollback source drift'
   if x['before']is None:
    if p.exists():p.unlink()
   else:
    src=backup/x['path'];assert sha(src)==x['before'];atomic(p,src.read_bytes(),src.stat().st_mode&0o777)
 if mode=='rollback':
  unchanged();restore();result={'rolled_back':True,'after':restart(False),'database_restored':False};atomic(D/'BRAIN-ROLLBACK.json',json.dumps(result,indent=2).encode());print(json.dumps(result));return
 assert not backup.exists()and not receipt.exists();backup.mkdir(mode=0o700)
 for x in ROWS:
  p=ROOT/x['path'];candidate=D/'stage'/x['path'];assert sha(candidate)==x['after']
  if p.exists():dst=backup/x['path'];dst.parent.mkdir(parents=True,exist_ok=True);atomic(dst,p.read_bytes(),p.stat().st_mode&0o777)
 atomic(backup/'env',ENV.read_bytes());atomic(backup/'source-before.json',json.dumps(oldmap,indent=2).encode())
 dbbackups=[]
 for key,default in [('DEVICES_DB_PATH','data/devices.db'),('PROFILE_DB_PATH','data/profile.db')]:
  src=Path(env.get(key,default));src=src if src.is_absolute()else ROOT/src
  if src.exists():
   dst=backup/(src.name+'.sqlite-backup');a=sqlite3.connect('file:'+str(src)+'?mode=ro',uri=True,timeout=3);b=sqlite3.connect(dst);a.backup(b,pages=128,sleep=.02);assert b.execute('pragma quick_check').fetchone()[0]=='ok';a.close();b.close();dbbackups.append({'name':src.name,'bytes':dst.stat().st_size,'sha256':sha(dst)})
 result={'before':before,'source_commit':MAN['source_commit'],'runtime_commit':MAN['runtime_commit'],'started_ms':int(time.time()*1000),'backup':str(backup),'dbbackups':dbbackups,'gates_enabled':False,'files':ROWS};written=False
 try:
  unchanged();written=True
  for x in ROWS:
   p=ROOT/x['path'];p.parent.mkdir(parents=True,exist_ok=True);mode=p.stat().st_mode&0o777 if p.exists()else 0o644;atomic(p,(D/'stage'/x['path']).read_bytes(),mode)
  check_files('after');post=restart(True)
  assert {k:v for k,v in pm().items()if k!='p003-voice'}==others,'other service changed'
  assert sha(ENV)==envsha,'env changed';newmap=snapshot();assert {k:v for k,v in newmap.items()if k not in target}=={k:v for k,v in oldmap.items()if k not in target},'unrelated source drift'
  result.update(success=True,after=post,other_files_unchanged=True,other_processes_unchanged=True,env_unchanged=True)
 except BaseException as ex:
  result.update(success=False,error_type=type(ex).__name__)
  if written:restore();result['rollback']=restart(False);result['database_restored']=False
  raise
 finally:
  result['finished_ms']=int(time.time()*1000);atomic(receipt,json.dumps(result,indent=2).encode());print(json.dumps(result))
if __name__=='__main__':main(sys.argv[1])
