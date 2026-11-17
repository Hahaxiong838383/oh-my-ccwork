# Removes only the onboarding identity key added by this release. Never restore the entire .env or database.
from pathlib import Path
import fcntl,hashlib,json,os,subprocess
D=Path('/opt/p003/onboarding-release-20261117');E=Path('/opt/p003/server/.env.local');K=b'VOICE_ONBOARDING_WORKER_ACCOUNTS'
os.umask(0o077)
release=json.loads((D/'SERVICE-IDENTITY-RELEASE.json').read_text());lock=E.with_name(E.name+'.config.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
before=E.read_bytes();lines=before.splitlines(keepends=True);matches=[l for l in lines if l.split(b'=',1)[0].strip()==K]
assert len(matches)==1 and hashlib.sha256(matches[0].split(b'=',1)[1].strip()).hexdigest()==release['value_sha256'],'identity key changed; inspect first'
# Caller must first close feature gates and verify no active lesson/room; keep additive DB schema/data.
for key in [b'VOICE_ONBOARDING_ENABLED',b'VOICE_ONBOARDING_V2_ENABLED']:
 assert not any(l.split(b'=',1)[0].strip()==key and l.split(b'=',1)[1].strip().strip(b'\"\'')==b'1'for l in lines),'close gates before rollback'
after=b''.join(l for l in lines if l not in matches);assert E.read_bytes()==before
backup=D/'service-identity-rollback-before.env';assert not backup.exists();backup.write_bytes(before);backup.chmod(0o600)
tmp=E.with_name(E.name+'.identity-rollback.tmp');fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
with os.fdopen(fd,'wb')as f:f.write(after);f.flush();os.fsync(f.fileno())
os.replace(tmp,E)
r=subprocess.run(['pm2','restart','p003-voice'],capture_output=True,text=True,timeout=35);assert r.returncode==0
print(json.dumps({'removed_only':K.decode(),'database_restored':False,'restart_requested':True,'must_verify_health':True}))
