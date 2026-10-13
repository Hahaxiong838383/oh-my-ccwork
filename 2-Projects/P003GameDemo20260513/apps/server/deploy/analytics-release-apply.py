#!/usr/bin/env python3
"""Verify and install Git-snapshot files only; no DB, env, package install or restart."""
import argparse,hashlib,json,os,tarfile,tempfile
from pathlib import Path

SERVER=Path('/opt/p003/server');ADMIN=Path('/opt/p003/web/dist/admin/index.html')
def digest(data):return hashlib.sha256(data).hexdigest()
def target_allowed(path):
 if path==ADMIN:return True
 try:relative=path.relative_to(SERVER)
 except ValueError:return False
 return str(relative) in ['package.json'] or relative.parts[0] in ['src','scripts','deploy','docs']
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--apply',action='store_true');a=p.parse_args();prepared=[]
 with tarfile.open(a.bundle,'r:gz') as tar:
  meta=json.load(tar.extractfile('release.json'))
  for item in meta['entries']:
   target=Path(item['target']);member=tar.getmember(item['member'])
   if not target.is_absolute() or not target_allowed(target) or target.is_symlink() or not member.isfile():raise ValueError('unexpected release member')
   if any(parent.is_symlink() for parent in target.parents if parent.exists()):raise ValueError('symlink target parent')
   data=tar.extractfile(member).read()
   if digest(data)!=item['sha256']:raise ValueError('new source digest mismatch')
   if target.exists():
    current=digest(target.read_bytes())
    if current not in [item.get('expected_current_sha256'),item['sha256']]:raise ValueError('target changed since baseline: '+str(target))
   elif item.get('expected_current_sha256') is not None:raise ValueError('expected baseline target missing')
   prepared.append((target,data,item['sha256']))
 if not a.apply:print(json.dumps({'ok':True,'verified_files':len(prepared),'commit':meta['commit'],'mutated':False}));return
 temps=[]
 try:
  for target,data,_ in prepared:
   target.parent.mkdir(parents=True,exist_ok=True)
   fd,temp=tempfile.mkstemp(prefix='.analytics-release-',dir=target.parent)
   with os.fdopen(fd,'wb') as file:os.fchmod(file.fileno(),0o644);file.write(data);file.flush();os.fsync(file.fileno())
   temps.append((Path(temp),target))
  for temp,target in temps:os.replace(temp,target)
  release=SERVER/'backups/analytics-releases/analytics-release-20261013';release.mkdir(parents=True,exist_ok=True,mode=0o700)
  receipt={'schema_version':1,'commit':meta['commit'],'baseline':meta['baseline'],'files':{str(target):sha for target,_,sha in prepared}}
  path=release/'manifest.json';path.write_text(json.dumps(receipt,indent=2)+'\n');os.chmod(path,0o600)
  print(json.dumps({'ok':True,'installed_files':len(prepared),'commit':meta['commit'],'manifest_path':str(path),'databases_changed':False}))
 finally:
  for temp,_ in temps:temp.unlink(missing_ok=True)
if __name__=='__main__':main()
