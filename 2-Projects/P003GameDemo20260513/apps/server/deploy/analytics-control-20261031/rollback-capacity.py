#!/usr/bin/env python3
"""Roll back only the 30-day forecasting change. Never modify data or device gates."""
from pathlib import Path
import argparse,hashlib,json,os,subprocess
parser=argparse.ArgumentParser();parser.add_argument('backup',type=Path);args=parser.parse_args();backup=args.backup.resolve()
assert str(backup).startswith('/opt/p003/backups/analytics-capacity-30d-20261031T')
m=json.loads((backup/'manifest.json').read_text());expected={'/opt/p003/server/src/analytics/capacity.ts','/opt/p003/web/dist/admin/index.html'}
assert len(m['files'])==2 and {f['path']for f in m['files']}==expected
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for i,f in enumerate(m['files']):
 assert sha(Path(f['path']))==f['new_sha'],'subsequent edit requires manual merge'
 assert sha(backup/('before-'+str(i)))==f['old_sha'],'backup digest mismatch'
for i,f in enumerate(m['files']):
 p=Path(f['path']);temp=p.with_suffix('.rollback-tmp');temp.write_bytes((backup/('before-'+str(i))).read_bytes());temp.chmod(0o644);os.replace(temp,p)
subprocess.run(['pm2','restart','p003-analytics'],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'ok':True,'forecast_restored_days':90,'upload_policy_modified':False,'business_data_modified':False}))
