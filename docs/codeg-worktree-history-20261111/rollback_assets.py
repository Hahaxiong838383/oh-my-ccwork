"""Default: verify rollback eligibility. --apply restores only exact after hashes."""
from pathlib import Path
import argparse, hashlib, json, os, stat, tempfile

p=argparse.ArgumentParser()
p.add_argument('--backup-dir',type=Path,required=True)
p.add_argument('--apply',action='store_true')
args=p.parse_args()
manifest=json.loads((args.backup_dir/'manifest.json').read_text())
def digest(data):return hashlib.sha256(data).hexdigest()
plans=[]
for item in manifest:
    target=Path(item['path'])
    backup=args.backup_dir/(item['name']+'.before')
    data=backup.read_bytes()
    if digest(data)!=item['before_sha256']:raise SystemExit('backup hash mismatch: '+item['name'])
    if digest(target.read_bytes())!=item['after_sha256']:raise SystemExit('runtime drift: '+item['name'])
    plans.append((item,target,data))
if args.apply:
    for item,target,data in plans:
        if digest(target.read_bytes())!=item['after_sha256']:raise SystemExit('runtime drift before write: '+item['name'])
        mode=stat.S_IMODE(target.stat().st_mode)
        fd,name=tempfile.mkstemp(prefix='.'+target.name+'.rollback.',dir=target.parent)
        try:
            os.fchmod(fd,mode)
            with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
            os.replace(name,target)
        finally:
            if os.path.exists(name):os.unlink(name)
        if digest(target.read_bytes())!=item['before_sha256']:raise SystemExit('post-restore hash mismatch')
        print(json.dumps({'file':item['name'],'restored':True}))
else:
    print(json.dumps({'eligible_files':len(plans),'applied':False}))
