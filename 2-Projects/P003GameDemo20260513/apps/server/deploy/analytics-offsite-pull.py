#!/usr/bin/env python3
"""Pull verified HK daily backups to private Studio storage; no secrets in output."""
import argparse,datetime,fcntl,hashlib,json,os,re,shlex,subprocess
from pathlib import Path

SSH=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes']
REMOTE='/opt/p003/server/backups/analytics-daily'
NAME=re.compile(r'^analytics-\d{8}T\d{12}Z\.sqlite3$')
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def run(args,**kwargs):
 if 'stdout' in kwargs:return subprocess.run(args,check=True,stderr=subprocess.PIPE,timeout=240,**kwargs)
 return subprocess.run(args,check=True,capture_output=True,timeout=240,**kwargs)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--destination',type=Path,required=True);p.add_argument('--direct-ssh',action='store_true',help='Use the same pinned HK alias without its optional proxy');a=p.parse_args();dest=a.destination.expanduser()
 ssh=SSH+(['-o','ProxyCommand=none'] if a.direct_ssh else [])
 if not dest.is_absolute() or dest.is_symlink():raise ValueError('private absolute destination required')
 dest.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(dest,0o700)
 lock=dest/'.pull.lock';fd=os.open(lock,os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:os.close(fd);raise RuntimeError('backup pull already running')
 try:
  code="from pathlib import Path;import json; p=Path('"+REMOTE+"'); names=sorted(p.glob('analytics-????????T????????????Z.json'),reverse=True)[:2];print(json.dumps([json.loads(n.read_text()) for n in names]))"
  manifests=json.loads(run(ssh+['aliyun-hk','python3 -c '+shlex.quote(code)]).stdout)
  if not manifests:raise RuntimeError('no HK verified backup available')
  received=0
  for meta in manifests:
   name=Path(meta['backup_path']).name
   if not NAME.fullmatch(name) or meta.get('integrity_check')!='ok' or not re.fullmatch('[a-f0-9]{64}',meta.get('sha256','')):raise ValueError('invalid remote manifest')
   target=dest/name
   if target.is_symlink():raise ValueError('backup target is a symlink')
   if not target.exists() or sha(target)!=meta['sha256']:
    temp=dest/('.'+name+'.incoming')
    run(['rsync','-a','--partial','--partial-dir=.rsync-partial','-e',shlex.join(ssh),'aliyun-hk:'+REMOTE+'/'+name,str(temp)])
    os.chmod(temp,0o600)
    if temp.stat().st_size!=meta['bytes'] or sha(temp)!=meta['sha256']:raise ValueError('offsite backup digest mismatch')
    os.replace(temp,target);received+=1
   os.chmod(target,0o600)
   m=target.with_suffix('.json');m.write_text(json.dumps(meta,indent=2)+'\n');os.chmod(m,0o600)
  # Stable HMAC/internal/JWT restoration material remains outside Git and handoff files.
  protected=dest/'protected'
  if protected.is_symlink():raise ValueError('protected destination is a symlink')
  protected.mkdir(exist_ok=True,mode=0o700);os.chmod(protected,0o700)
  tmp=protected/'.env.analytics.incoming'
  with tmp.open('wb') as f:
   os.chmod(tmp,0o600);run(ssh+['aliyun-hk','cat /opt/p003/server/.env.analytics'],stdout=f)
   f.flush();os.fsync(f.fileno())
  os.replace(tmp,protected/'.env.analytics')
  cutoff=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=7)
  for item in dest.glob('analytics-????????T????????????Z.sqlite3'):
   if not NAME.fullmatch(item.name) or item.is_symlink():continue
   stamp=datetime.datetime.strptime(item.name[10:25],'%Y%m%dT%H%M%S').replace(tzinfo=datetime.timezone.utc)
   if stamp<cutoff:item.unlink();item.with_suffix('.json').unlink(missing_ok=True)
  report={'ok':True,'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verified_remote_backups':len(manifests),'received':received,'retention_days':7,'protected_runtime_env_copied':True,'direct_ssh':a.direct_ssh}
  state=dest/'last-success.json';state.write_text(json.dumps(report,indent=2)+'\n');os.chmod(state,0o600);print(json.dumps(report))
 finally:fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)
if __name__=='__main__':
 try:main()
 except Exception:print(json.dumps({'ok':False,'error':'ANALYTICS_OFFSITE_BACKUP_FAILED'}));raise SystemExit(1)
