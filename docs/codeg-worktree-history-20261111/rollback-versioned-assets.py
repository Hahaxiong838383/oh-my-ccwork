"""Verify by default; --apply restores only the versioned-publication step."""
from pathlib import Path
import argparse,hashlib,json,os,tempfile
p=argparse.ArgumentParser();p.add_argument('--backup-dir',type=Path,required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
m=json.loads((a.backup_dir/'MANIFEST.json').read_text());root=Path(m['root']);sha=lambda b:hashlib.sha256(b).hexdigest()
for row in m['files']:
    assert sha((root/row['relative']).read_bytes())==row['after_sha256'],'runtime drift: '+row['relative']
    if row.get('backup'):assert sha((a.backup_dir/row['backup']).read_bytes())==row['before_sha256'],'backup drift'
# Restore routes first, then remove only the newly created assets.
if a.apply:
    for row in sorted(m['files'],key=lambda r:not bool(r.get('backup'))):
        path=root/row['relative'];assert sha(path.read_bytes())==row['after_sha256'],'write drift'
        if row.get('backup'):
            data=(a.backup_dir/row['backup']).read_bytes();fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.rollback.',dir=path.parent)
            try:
                os.fchmod(fd,row['mode'])
                with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
                os.replace(tmp,path)
            finally:
                if os.path.exists(tmp):os.unlink(tmp)
            assert sha(path.read_bytes())==row['before_sha256']
        else:path.unlink()
        print(json.dumps({'restored':row['relative']}))
else:print(json.dumps({'eligible_files':len(m['files']),'applied':False}))
