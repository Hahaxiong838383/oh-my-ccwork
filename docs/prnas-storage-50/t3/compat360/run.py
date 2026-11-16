#!/usr/bin/env python3
"""Rebuild a disposable session360 + T1/T3 compatibility fixture. No production access."""
import argparse,hashlib,io,json,os,subprocess,tarfile
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--repo',required=True,type=Path);p.add_argument('--candidate',required=True)
p.add_argument('--node',required=True,type=Path);p.add_argument('--out',required=True,type=Path)
a=p.parse_args();repo=a.repo.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=False)
base='2-Projects/P003GameDemo20260513';server=base+'/apps/server'
fixed='5d24359d15fb33f5d91621db3dc35af6dd1a4828'
def git(*args):return subprocess.check_output(['git','-C',str(repo),*args])
candidate=git('rev-parse',a.candidate).decode().strip()
data=git('archive',fixed,server,base+'/docs')
with tarfile.open(fileobj=io.BytesIO(data)) as t:
    for m in t.getmembers():
        if m.name.startswith('/') or '..' in Path(m.name).parts or m.issym() or m.islnk():raise ValueError('unsafe archive')
    t.extractall(out)
overlay=['src/ark/store.ts','src/ark/service.ts','src/ark/routes.ts','src/ark/archive.ts','src/storage/policy.ts','src/storage/routes.ts','src/config-store.ts']
protected=['src/ark/records-contract.ts','src/ark/records-store.ts','src/ark/records-service.ts','src/ark/records-routes.ts','src/routes/telemetry.ts','src/routes/ark.ts','src/parent-conversations.ts']
manifest={'session360_sha':fixed,'candidate':candidate,'overlay_files':{},'protected_files':{}}
s=out/server
for f in overlay:
    body=git('show',candidate+':'+server+'/'+f);target=s/f;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body);manifest['overlay_files'][f]=hashlib.sha256(body).hexdigest()
for f in protected:
    assert (s/f).read_bytes()==git('show',fixed+':'+server+'/'+f)
    manifest['protected_files'][f]=hashlib.sha256((s/f).read_bytes()).hexdigest()
(s/'node_modules').symlink_to((repo/server/'node_modules').resolve(),target_is_directory=True)
subprocess.run(['git','apply','--unsafe-paths',str(Path(__file__).with_name('fixtures.patch'))],cwd=out,check=True)
# Exporter and its T2 dependency are also frozen from candidate, never live worktree.
export=out/'exporter';export.mkdir()
for f in ['storage-ark-export.py','storage-archive.py']:(export/f).write_bytes(git('show',candidate+':'+server+'/scripts/'+f))
env={**os.environ,'TEST_ARCHIVE_ENABLED':'1','TEST_NODE':str(a.node.resolve()),'T3_EXPORT_SCRIPT':str(export/'storage-ark-export.py')}
manifest['tests']=[]
for name in ['ark-records.test.ts','ark-records-summaries.test.ts','parent-conversations.test.ts','mini008-dashboard.test.ts']:
    result=subprocess.run([str(a.node.resolve()),'--experimental-sqlite','--import','tsx','scripts/'+name],cwd=s,env=env,capture_output=True,text=True,timeout=180)
    log=out/(name+'.txt');log.write_text(result.stdout+result.stderr)
    manifest['tests'].append({'name':name,'exit':result.returncode,'sha256':hashlib.sha256(log.read_bytes()).hexdigest()})
(out/'RESULT.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps(manifest['tests'],indent=2))
raise SystemExit(0 if all(x['exit']==0 for x in manifest['tests']) else 1)
