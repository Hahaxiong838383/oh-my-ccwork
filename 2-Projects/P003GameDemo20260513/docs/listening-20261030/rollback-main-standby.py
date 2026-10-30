#!/usr/bin/env python3
"""Rollback this unopened listening candidate only. Default is read-only validation.
First stop the isolated Worker and its cleanup timer on the voice host.
Never restores a whole database or changes current ordinary/search Worker units.
"""
import argparse,hashlib,json,pathlib,shutil,sqlite3,subprocess,time,urllib.request
p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');a=p.parse_args()
b=pathlib.Path('/opt/p003/backups/listening-20261030');main=pathlib.Path('/opt/p003/server');nginx=pathlib.Path('/etc/nginx/sites-enabled/kidshub-ai');manifest=json.loads((b/'manifest.json').read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
for x in manifest:assert sha(pathlib.Path(x['target']))==x['after_sha256'],'source drift: '+x['target']
assert sha(main/'.env.local')==sha(b/'main.env.after'),'environment drift';assert sha(nginx)==sha(b/'nginx.after'),'nginx drift'
d=sqlite3.connect('file:'+str(main/'data/config.db')+'?mode=rw',uri=True);d.execute('PRAGMA busy_timeout=2000')
flags=dict(d.execute("SELECT key,value FROM runtime_flag WHERE key LIKE 'p003.search.canary.%'"));assert flags==json.loads((b/'search-flags.before.json').read_text()),'search scope changed: do not use standby rollback after cutover'
c=json.loads(d.execute('SELECT value_json FROM listening_settings WHERE id=1').fetchone()[0]);assert c['revision']==4 and c['enabled']is False,'listening config changed: review rollback first'
if not a.apply:print(json.dumps({'rollback_preflight':True,'files':len(manifest),'config_revision':c['revision'],'would_restore_legacy_shape_at_new_revision':5}));d.close();raise SystemExit(0)
subprocess.run(['systemctl','disable','--now','p003-listening-brain.service'],check=True)
# Restore only the listening record, maintaining monotonic audit revisions.
# The old UI parser does not accept the newly added voice_invitation_enabled key.
d.execute('BEGIN IMMEDIATE');current=json.loads(d.execute('SELECT value_json FROM listening_settings WHERE id=1').fetchone()[0]);assert current==c,'concurrent listening edit';old=json.loads((b/'listening-config.before.json').read_text());old['revision']=c['revision']+1;old['enabled']=False;at=int(time.time()*1000);actor='codex-listening-standby-rollback'
d.execute('UPDATE listening_settings SET revision=?,value_json=?,updated_at=?,updated_by=? WHERE id=1',(old['revision'],json.dumps(old),at,actor));d.execute('INSERT INTO listening_settings_audit VALUES(?,?,?,?,?,?)',(old['revision'],'restore',actor,at,json.dumps(c),json.dumps(old)));d.commit();d.close()
def atomic(src,dest):
 t=dest.with_name(dest.name+'.listening-rollback');shutil.copy2(src,t);t.replace(dest)
for x in manifest:
 dest=pathlib.Path(x['target'])
 if x['before_sha256']is None:dest.unlink()
 else:atomic(b/'restore'/dest.relative_to('/opt/p003'),dest)
atomic(b/'main.env.before',main/'.env.local');atomic(b/'nginx.before',nginx)
subprocess.run(['nginx','-t'],check=True);subprocess.run(['pm2','restart','p003-voice'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
for _ in range(30):
 try:
  with urllib.request.urlopen('http://127.0.0.1:3001/health',timeout=2)as r:
   if r.status==200:break
 except:time.sleep(.5)
else:raise RuntimeError('main health unavailable after rollback')
for x in manifest:
 t=pathlib.Path(x['target']);assert (sha(t)if t.exists()else None)==x['before_sha256']
print(json.dumps({'restored_files':len(manifest),'main_health':200,'listening_enabled':False,'revision':old['revision'],'other_databases_preserved':True}))
