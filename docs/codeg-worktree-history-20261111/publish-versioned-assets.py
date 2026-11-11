"""Prepare/apply only verified file-name changes. Never reload agents or touch DB."""
from pathlib import Path
import argparse, hashlib, json, os, stat, tempfile

args=argparse.ArgumentParser()
args.add_argument('--apply',action='store_true')
options=args.parse_args()
D=Path(__file__).parent/'cache-publication-v2'
D.mkdir(exist_ok=True)
ROOT=Path(os.environ['CODEG_STATIC_DIR']).resolve()
sha=lambda b:hashlib.sha256(b).hexdigest()
source_manifest=json.loads((D.parent/'manifest.json').read_text())
mapping={}
plan=[]
for row in source_manifest:
    source=Path(row['path'])
    data=source.read_bytes()
    assert sha(data)==row['after_sha256'],'store source drift'
    new_name=source.stem+'-wt-'+row['after_sha256'][:12]+'.js'
    mapping[row['name']]=new_name
    relative=Path('_next/static/chunks')/new_name
    assert not (ROOT/relative).exists(),'versioned file already exists'
    candidate=D/(new_name+'.candidate');candidate.write_bytes(data)
    plan.append({'relative':str(relative),'before_sha256':None,'after_sha256':sha(data),'candidate':candidate.name,'mode':stat.S_IMODE(source.stat().st_mode)})
expected={'workspace.html','workspace.txt','workspace/__next._full.txt','workspace/__next.workspace.__PAGE__.txt','commit.html','commit.txt','commit/__next._full.txt','commit/__next.commit.__PAGE__.txt'}
found=set()
for p in ROOT.rglob('*'):
    if not p.is_file() or p.suffix not in ['.html','.txt','.json','.js'] or '/vs/' in str(p):continue
    old=p.read_bytes()
    if not any(n.encode()in old for n in mapping):continue
    relative=str(p.relative_to(ROOT));assert relative in expected,'unexpected asset reference '+relative
    new=old
    for source,target in mapping.items():new=new.replace(source.encode(),target.encode())
    key=relative.replace('/','__')
    (D/(key+'.before')).write_bytes(old);(D/(key+'.candidate')).write_bytes(new)
    plan.append({'relative':relative,'before_sha256':sha(old),'after_sha256':sha(new),'backup':key+'.before','candidate':key+'.candidate','mode':stat.S_IMODE(p.stat().st_mode)})
    found.add(relative)
assert found==expected,(found,expected)
manifest={'root':str(ROOT),'mapping':mapping,'files':plan,'strategy':'new_content_versioned_urls_keep_old_assets','sw_changed':False}
(D/'MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
if options.apply:
    for row in plan:
        target=ROOT/row['relative']
        assert (sha(target.read_bytes())if target.exists()else None)==row['before_sha256'],'preflight drift'
    for row in plan:
        target=ROOT/row['relative']
        assert (sha(target.read_bytes())if target.exists()else None)==row['before_sha256'],'write drift'
        data=(D/row['candidate']).read_bytes();assert sha(data)==row['after_sha256']
        fd,tmp=tempfile.mkstemp(prefix='.'+target.name+'.',dir=target.parent)
        try:
            os.fchmod(fd,row['mode'])
            with os.fdopen(fd,'wb')as f:f.write(data);f.flush();os.fsync(f.fileno())
            os.replace(tmp,target)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
        assert sha(target.read_bytes())==row['after_sha256']
        row['applied']=True
        (D/'APPLIED.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'prepared':len(plan),'new_assets':2,'route_references':len(found),'applied':options.apply,'mapping':mapping}))
