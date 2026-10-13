#!/usr/bin/env python3
"""Close collection or restore only release-owned code; keep all accepted/seen data."""
import argparse,hashlib,json,os,subprocess,tarfile,tempfile
from pathlib import Path

SERVER=Path('/opt/p003/server')
def run(args):
 p=subprocess.run(args,cwd=SERVER,capture_output=True,text=True,timeout=45)
 if p.returncode:raise RuntimeError('rollback substep failed: '+Path(args[0]).name)
 return p.stdout
def digest(data):return hashlib.sha256(data).hexdigest()
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
   if target.is_symlink() or not target.is_file() or digest(target.read_bytes())!=new_sha:raise ValueError('release-owned target changed; do not overwrite later work')
   member=tar.getmember(path.lstrip('/'))
   if not member.isfile():raise ValueError('snapshot member is not an ordinary file')
   content=tar.extractfile(member).read()
   if digest(content)!=manifest['files'][path]:raise ValueError('snapshot member digest mismatch')
   result.append((target,content,target.stat().st_mode&0o777))
 if not result:raise ValueError('no release-owned baseline code')
 return result
def atomic_write(path,data,mode):
 fd,temp=tempfile.mkstemp(prefix='.analytics-rollback-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as file:os.fchmod(file.fileno(),mode);file.write(data);file.flush();os.fsync(file.fileno())
  os.replace(temp,path)
  fd=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:Path(temp).unlink(missing_ok=True)
def main():
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
  for path,content,mode in items:atomic_write(path,content,mode)
  run(['/usr/bin/pm2','restart','p003-voice','--update-env'])
  run(['/usr/bin/pm2','save'])
 print(json.dumps({'ok':True,'server_gate':False,'upload_enabled':False,'code_files_restored':len(items),'analytics_database_preserved':True,'nginx_json_503_fallback_preserved':True}))
if __name__=='__main__':
 try:main()
 except Exception as error:print(json.dumps({'ok':False,'error':str(error)[:180]}));raise SystemExit(1)
