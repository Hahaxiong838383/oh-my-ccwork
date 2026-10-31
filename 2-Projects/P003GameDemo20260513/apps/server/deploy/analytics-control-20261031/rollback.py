#!/usr/bin/env python3
"""Restore only this release's files after SHA checks. Never restore a live DB."""
import argparse,hashlib,json,os,subprocess,sqlite3
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('backup',type=Path);a=p.parse_args();b=a.backup.resolve();assert str(b).startswith('/opt/p003/backups/analytics-control-20261031T')
m=json.loads((b/'manifest.json').read_text());applied=json.loads((b/'applied.json').read_text());roots={'main':Path('/opt/p003/server'),'p2':Path('/opt/p003/search-canary-20261021/brain'),'ui':Path('/opt/p003/web/dist/admin')};sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for f in m['files']:
 path=roots[f['group']]/f['rel'];assert path.is_relative_to(roots[f['group']]);assert sha(path)==f['sha'],('file changed after release; merge rollback manually',str(path))
for key,want in applied['env_after_sha'].items():
 g,f=key.split('/',1);assert sha(roots[g]/f)==want,('env changed after release',key)
def put(path,data,mode):
 temp=path.with_name(path.name+'.rollback-tmp');temp.write_bytes(data);temp.chmod(mode);os.replace(temp,path)
# A newly managed policy cannot be interpreted by old code: close the hard gate
# before restoring old files so a previously revoked legacy SN cannot reopen.
c=sqlite3.connect('file:/opt/p003/server/data/config.db?mode=ro',uri=True);managed=c.execute("select value from runtime_flag where key='analytics.upload_policy.v1'").fetchone();c.close()
if managed:put(roots['main']/'data/analytics-control.json',b'{"enabled":false}\n',0o600)
for f in m['files']:
 path=roots[f['group']]/f['rel'];old=b/'before'/f['group']/f['rel']
 if old.exists():put(path,old.read_bytes(),old.stat().st_mode&0o777)
 else:path.unlink()
for key in applied['env_after_sha']:
 g,f=key.split('/',1);put(roots[g]/f,(b/'before'/g/f).read_bytes(),0o600)
for cmd in [['pm2','restart','p003-voice'],['pm2','restart','p003-analytics'],['systemctl','restart','p003-search-brain']]:subprocess.run(cmd,check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'ok':True,'code_rolled_back':True,'managed_uploads_hard_closed':bool(managed),'databases_restored':False}))
