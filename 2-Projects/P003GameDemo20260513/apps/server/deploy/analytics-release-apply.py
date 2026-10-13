#!/usr/bin/env python3
"""Verify and install Git-snapshot files only; no DB, env, package install or restart."""
import argparse,hashlib,json,os,tarfile,tempfile,stat,contextlib,re,io
from pathlib import Path

SERVER=Path('/opt/p003/server');ADMIN=Path('/opt/p003/web/dist/admin/index.html')
def digest(data):return hashlib.sha256(data).hexdigest()
def release_id(value):
 if len(value)>128 or not re.fullmatch(r'analytics-release-(?:[a-z][a-z0-9]*-)*[0-9]{8}(?:T[0-9]{6}Z)?(?:-[A-Za-z0-9]+)*',value):raise argparse.ArgumentTypeError('release-id must be a safe analytics-release basename containing YYYYMMDD')
 return value
def target_allowed(path):
 if '..' in path.parts:return False
 if path==ADMIN:return True
 try:relative=path.relative_to(SERVER)
 except ValueError:return False
 return str(relative) in ['package.json'] or bool(relative.parts) and relative.parts[0] in ['src','scripts','deploy','docs']

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

def _main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--apply',action='store_true');p.add_argument('--release-id',type=release_id,default='analytics-release-20261013');a=p.parse_args();prepared=[]
 # Verify the same immutable archive bytes whose digest is bound to this release.
 bundle_data=a.bundle.read_bytes()
 with tarfile.open(fileobj=io.BytesIO(bundle_data),mode='r:gz') as tar:
  meta=json.load(tar.extractfile('release.json'))
  for item in meta['entries']:
   target=Path(item['target']);member=tar.getmember(item['member'])
   if not target.is_absolute() or not target_allowed(target) or target.is_symlink() or not member.isfile():raise ValueError('unexpected release member')
   if any(parent.is_symlink() for parent in target.parents if parent.exists()):raise ValueError('symlink target parent')
   data=tar.extractfile(member).read()
   if digest(data)!=item['sha256']:raise ValueError('new source digest mismatch')
   expected=capture_target(target)
   if expected['file'] is not None:
    current=expected['sha']
    if current not in [item.get('expected_current_sha256'),item['sha256']]:raise ValueError('target changed since baseline: '+str(target))
   elif item.get('expected_current_sha256') is not None:raise ValueError('expected baseline target missing')
   prepared.append((target,data,item['sha256'],expected))
 release=SERVER/'backups/analytics-releases'/a.release_id;manifest=release/'manifest.json';manifest_expected=capture_target(manifest)
 receipt={'schema_version':1,'release_id':a.release_id,'bundle_sha256':digest(bundle_data),'commit':meta['commit'],'baseline':meta['baseline'],'files':{str(target):sha for target,_,sha,_ in prepared}}
 if manifest_expected['file'] is not None:
  with os.fdopen(os.open(manifest,os.O_RDONLY|os.O_NOFOLLOW),'rb') as source:prior=source.read()
  require_unchanged(manifest,manifest_expected)
  # Legacy receipts without a bundle digest cannot prove package identity; retain
  # them untouched and require a new release-id instead of reusing their name.
  if digest(prior)!=manifest_expected['sha'] or json.loads(prior)!=receipt:raise ValueError('release-id already identifies a different bundle; choose a new release-id')
 if not a.apply:print(json.dumps({'ok':True,'verified_files':len(prepared),'commit':meta['commit'],'release_id':a.release_id,'manifest_path':str(manifest),'mutated':False}));return
 temps=[]
 try:
  for target,data,_,expected in prepared:
   target.parent.mkdir(parents=True,exist_ok=True)
   fd,temp=tempfile.mkstemp(prefix='.analytics-release-',dir=target.parent)
   with os.fdopen(fd,'wb') as file:os.fchmod(file.fileno(),0o644);file.write(data);file.flush();os.fsync(file.fileno())
   temps.append((Path(temp),target,expected))
  for _,target,expected in temps:require_unchanged(target,expected)
  require_unchanged(manifest,manifest_expected)
  for temp,target,expected in temps:
   require_unchanged(target,expected);os.replace(temp,target);sync_directory(target.parent)
  release.mkdir(parents=True,exist_ok=True,mode=0o700)
  path=manifest;fd,temp=tempfile.mkstemp(prefix='.analytics-manifest-',dir=release);temps.append((Path(temp),path,manifest_expected))
  with os.fdopen(fd,'wb') as file:os.fchmod(file.fileno(),0o600);file.write((json.dumps(receipt,indent=2)+'\n').encode());file.flush();os.fsync(file.fileno())
  require_unchanged(path,manifest_expected);os.replace(temp,path);sync_directory(release)
  print(json.dumps({'ok':True,'installed_files':len(prepared),'commit':meta['commit'],'manifest_path':str(path),'databases_changed':False}))
 finally:
  for temp,_,_ in temps:temp.unlink(missing_ok=True)
def main():
 with deployment_lock():_main()
if __name__=='__main__':
 try:main()
 except Exception:print(json.dumps({'ok':False,'error':'ANALYTICS_RELEASE_APPLY_FAILED'}));raise SystemExit(1)
