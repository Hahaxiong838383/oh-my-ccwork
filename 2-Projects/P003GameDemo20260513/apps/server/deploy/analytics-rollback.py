#!/usr/bin/env python3
"""Close collection or restore only release-owned code; keep all accepted/seen data."""
import argparse,hashlib,json,os,subprocess,tarfile,tempfile,stat,contextlib
from pathlib import Path

SERVER=Path('/opt/p003/server')
def run(args):
 p=subprocess.run(args,cwd=SERVER,capture_output=True,text=True,timeout=45)
 if p.returncode:raise RuntimeError('rollback substep failed: '+Path(args[0]).name)
 return p.stdout
def digest(data):return hashlib.sha256(data).hexdigest()

@contextlib.contextmanager
def deployment_lock():
 # All three cooperating release/rollback/env tools use the same atomic mkdir lock.
 lock=SERVER/'.analytics-deploy.lock'
 try:lock.mkdir(mode=0o700)
 except FileExistsError:raise ValueError('analytics deployment lock busy')
 identity=(lock.stat().st_dev,lock.stat().st_ino)
 try:yield
 finally:
  try:
   current=lock.lstat()
   if (current.st_dev,current.st_ino)==identity:lock.rmdir()
  except FileNotFoundError:pass

def capture_target(path):
 parents={}
 for parent in path.parents:
  try:info=parent.lstat()
  except FileNotFoundError:continue
  if not stat.S_ISDIR(info.st_mode):raise ValueError('unsafe target parent')
  parents[str(parent)]=(info.st_dev,info.st_ino)
 try:info=path.lstat()
 except FileNotFoundError:return {'file':None,'sha':None,'parents':parents}
 if not stat.S_ISREG(info.st_mode):raise ValueError('target is not an ordinary file')
 def identity(info):return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as source:
  before=os.fstat(source.fileno());data=source.read();after=os.fstat(source.fileno())
 if identity(info)!=identity(before) or identity(before)!=identity(after) or identity(after)!=identity(path.lstat()):raise ValueError('target changed while reading')
 return {'file':identity(after),'sha':digest(data),'parents':parents}

def require_unchanged(path,expected):
 actual=capture_target(path)
 if actual['file']!=expected['file'] or actual['sha']!=expected['sha'] or any(actual['parents'].get(parent)!=value for parent,value in expected['parents'].items()):raise ValueError('target changed before replacement; later work preserved')

def sync_directory(path):
 fd=os.open(path,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)

def plan_restore(snapshot,release):
 snapshot=Path(snapshot).resolve(strict=True)
 if snapshot.parent!=SERVER/'backups/analytics-releases' or not snapshot.name.startswith('analytics-predeploy-'):raise ValueError('unexpected snapshot')
 manifest=json.loads((snapshot/'manifest.json').read_text());archive=snapshot/'source-only.tar.gz'
 if digest(archive.read_bytes())!=manifest['source_archive_sha256']:raise ValueError('source archive digest mismatch')
 deployed=json.loads(Path(release).read_text())['files'];result=[]
 with tarfile.open(archive,'r:gz') as tar:
  for path,new_sha in deployed.items():
   if path not in manifest['files']:continue # New files remain for a later redeploy.
   if not (path.startswith(str(SERVER)+'/src/') or path==str(SERVER/'package.json') or path=='/opt/p003/web/dist/admin/index.html'):continue
   target=Path(path)
   expected=capture_target(target)
   if expected['sha']!=new_sha:raise ValueError('release-owned target changed; do not overwrite later work')
   member=tar.getmember(path.lstrip('/'))
   if not member.isfile():raise ValueError('snapshot member is not an ordinary file')
   content=tar.extractfile(member).read()
   if digest(content)!=manifest['files'][path]:raise ValueError('snapshot member digest mismatch')
   result.append((target,content,expected['file'][2]&0o777,expected))
 if not result:raise ValueError('no release-owned baseline code')
 return result
def atomic_write(path,data,mode,expected=None):
 if expected is None:expected=capture_target(path)
 fd,temp=tempfile.mkstemp(prefix='.analytics-rollback-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as file:os.fchmod(file.fileno(),mode);file.write(data);file.flush();os.fsync(file.fileno())
  require_unchanged(path,expected);os.replace(temp,path)
  fd=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:Path(temp).unlink(missing_ok=True)
def _main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--code',action='store_true');p.add_argument('--snapshot');p.add_argument('--release-manifest');p.add_argument('--check-only',action='store_true');a=p.parse_args()
 if a.code and not(a.snapshot and a.release_manifest):p.error('--code requires --snapshot and --release-manifest')
 items=plan_restore(a.snapshot,a.release_manifest) if a.code else []
 if a.check_only:print(json.dumps({'ok':True,'checked_code_files':len(items),'data_restore':False}));return
 run(['/usr/bin/python3','scripts/analytics-control.py','--control',str(SERVER/'data/analytics-control.json'),'--disable'])
 # If this fails, the hot gate is already closed; do not proceed to code restoration.
 run(['/usr/bin/node','--env-file=.env.local','deploy/analytics-config-off.mjs'])
 if a.code:
  run(['/usr/bin/systemctl','disable','--now','p003-analytics-rollup.timer','p003-analytics-backup.timer'])
  run(['/usr/bin/systemctl','stop','p003-analytics-rollup.service','p003-analytics-backup.service'])
  run(['/usr/bin/pm2','stop','p003-analytics'])
  # Revalidate the entire restore after slow config/service substeps, before any code write.
  items=plan_restore(a.snapshot,a.release_manifest)
  prepared=items
  for path,_,_,expected in prepared:require_unchanged(path,expected)
  for path,content,mode,expected in prepared:atomic_write(path,content,mode,expected)
  run(['/usr/bin/pm2','restart','p003-voice','--update-env'])
  run(['/usr/bin/pm2','save'])
 print(json.dumps({'ok':True,'server_gate':False,'upload_enabled':False,'code_files_restored':len(items),'analytics_database_preserved':True,'nginx_json_503_fallback_preserved':True}))
def main():
 with deployment_lock():_main()
if __name__=='__main__':
 try:main()
 except Exception as error:print(json.dumps({'ok':False,'error':str(error)[:180]}));raise SystemExit(1)
