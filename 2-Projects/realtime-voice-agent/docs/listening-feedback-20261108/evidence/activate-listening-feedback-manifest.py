from pathlib import Path
import json,time,hashlib,os
p=Path('/opt/p003/listening-canary-20261030/listening-release.json');b=p.read_bytes()
backup=p.parent/'backups/feedback-20261108-50bac0b2'
if (backup/'receipt.json').exists():
 r=json.loads((backup/'receipt.json').read_text());assert hashlib.sha256(b).hexdigest()==r['after_sha256'],'already_applied_but_drifted';print(json.dumps({**r,'recovered_existing_receipt':True}));raise SystemExit()
assert hashlib.sha256(b).hexdigest()=='7302c4eba5a15fd6c042c03a9bc30b373413d4e1c6278eb6edc703bef90cea76','manifest_drift'
v=json.loads(b);assert v['expires_at_ms']==1794391200000 and len(v['agents'])==1
assert v['agents'][0]['build_sha']=='de09010304f2a44556bd706c7b810828062b4433'and v['agents'][0]['agent']=='p003-search-listening-20261030'
v['agents'][0]['build_sha']='50bac0b28c4f44e169ad574c08682fe509a72a46';v['evidence_ref']='feedback-20261108:50bac0b2;665-rust;3-RTC-synthetic;existing-single-SN'
backup=p.parent/'backups/feedback-20261108-50bac0b2';backup.mkdir(mode=0o700,exist_ok=False);(backup/'before.json').write_bytes(b);(backup/'before.json').chmod(0o600)
new=(json.dumps(v,indent=2)+'\n').encode();tmp=p.with_suffix('.feedback-20261108.tmp')
with tmp.open('wb')as f:f.write(new);f.flush();os.fsync(f.fileno())
tmp.chmod(0o600);assert p.read_bytes()==b;os.replace(tmp,p)
result={'success':True,'at_ms':int(time.time()*1000),'before_sha256':hashlib.sha256(b).hexdigest(),'after_sha256':hashlib.sha256(new).hexdigest(),'build_sha':v['agents'][0]['build_sha'],'backup':str(backup),'expiry_capabilities_unchanged':True}
(backup/'receipt.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
