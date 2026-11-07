from pathlib import Path
import json,hashlib,os,time
p=Path('/opt/p003/listening-canary-20261030/listening-release.json');B=p.parent/'backups/feedback-20261108-50bac0b2';r=json.loads((B/'receipt.json').read_text());b=(B/'before.json').read_bytes()
assert hashlib.sha256(b).hexdigest()==r['before_sha256']
assert hashlib.sha256(p.read_bytes()).hexdigest()==r['after_sha256'],'manifest_drift'
t=p.with_suffix('.rollback-feedback.tmp');t.write_bytes(b);t.chmod(0o600);os.replace(t,p)
print(json.dumps({'restored':True,'at_ms':int(time.time()*1000),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}))
