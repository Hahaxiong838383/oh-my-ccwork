#!/usr/bin/env python3
# Run on aliyun-hk only when rollback is explicitly being executed. Never restores databases.
import hashlib,json,os,pathlib,subprocess,urllib.request,time
root=pathlib.Path('/opt/p003/server');backup=root/'backups/sms-login-20261103T084911Z'
m=json.loads((backup/'manifest.json').read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
for f in m['files']:
 assert sha(root/f['path'])==f['after_sha256'],'current drift; stop: '+f['path']
 assert sha(backup/f['path'])==f['before_sha256'],'backup mismatch: '+f['path']
for f in m['files']:
 p=root/f['path'];tmp=p.with_name(p.name+'.sms-rollback');tmp.write_bytes((backup/f['path']).read_bytes());tmp.chmod(p.stat().st_mode&0o777);os.replace(tmp,p)
subprocess.run(['pm2','restart','p003-voice'],check=True)
for _ in range(15):
 try:
  with urllib.request.urlopen('http://127.0.0.1:3001/health',timeout=2)as r:
   assert r.status==200
   print('rollback source restored, health 200; databases preserved; active HMAC codes require re-send')
   break
 except Exception:time.sleep(1)
else:raise SystemExit('rollback health failed; inspect pm2 without restoring databases')
