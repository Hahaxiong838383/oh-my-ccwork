"""Post-release, read-only source/services/policy and bounded Ark log observation."""
from pathlib import Path
import json,hashlib,subprocess,sqlite3,urllib.request,urllib.error,datetime
D=Path('/root/p003-clock-release-20261118');baseline=json.loads((D/'BASELINE.json').read_text());manifest=json.loads((D/'candidate/MANIFEST.json').read_text());out={'at':datetime.datetime.now().astimezone().isoformat(),'pools':[]}
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for i,pool in enumerate(baseline['pools']):
 root=Path(pool['root']);receipt=json.loads((D/f'RELEASE-{i}.json').read_text());assert receipt['success']
 expected=dict(pool['sources']);expected.update({r['path']:r['after_sha256'] for r in manifest if r['pool']==str(root)})
 assert all(sha(root/n)==h for n,h in expected.items())
 assert all(sha(root/n)==h for n,h in pool['env_hashes'].items())
 with urllib.request.urlopen('http://127.0.0.1:'+str([3001,3007,3008][i])+'/health',timeout=3) as r:health={'status':r.status,'body':json.load(r)}
 db=sqlite3.connect('file:'+str(root/'data/config.db')+'?mode=ro',uri=True)
 flags=dict(db.execute("SELECT key,value FROM runtime_flag WHERE key IN ('p003.search.enabled','p003.search.scope','p003.search.tools','p003.search.canary.expires_at_ms')"));db.close()
 db=sqlite3.connect('file:'+str(root/'data/conversation.db')+'?mode=ro',uri=True)
 # Only count new real RTC user turns; content/identity never exported here.
 real=db.execute("SELECT COUNT(*) FROM conversation WHERE role='user' AND session_id='rtc' AND ts>=? AND account_id NOT LIKE 'clock-release-%'",(receipt['finished_ms'],)).fetchone()[0];db.close()
 out['pools'].append({'pool':i,'path':str(root),'release_finished_ms':receipt['finished_ms'],'source_files_verified':len(expected),'clock_sha256':sha(root/'src/tools/clock-query.ts'),'env_unchanged':True,'health':health,'search_flags':flags,'new_nonprobe_rtc_user_turns':real})
p=Path('/var/log/nginx/kidshub-ai-access.log');pre=json.loads((D/'ARK-PRE.json').read_text());assert p.stat().st_ino==pre['log_inode'],'log rotation: inspect both files'
rows=[]
with p.open() as f:
 f.seek(pre['log_size'])
 for line in f:
  if '/v1/device/ark/state ' not in line:continue
  parts=line.split('"');rows.append({'time':line.split('[')[1].split(']')[0],'status':int(parts[2].split()[0])})
out['ark_since_checkpoint']={'rows':rows,'count':len(rows),'errors':[r for r in rows if r['status']>=500]}
request=urllib.request.Request('https://kidshub-ai.hahaxiong.cc/v1/device/ark/state',data=b'{}',headers={'Content-Type':'application/json'},method='POST')
try:urllib.request.urlopen(request,timeout=10);raise AssertionError('unauthenticated public Ark accepted')
except urllib.error.HTTPError as e:assert e.code==401;out['public_ark_unauthorized_status']=e.code
pm=json.loads(subprocess.check_output(['pm2','jlist']));out['pm2']=[{'name':x['name'],'pid':x['pid'],'status':x['pm2_env']['status'],'restarts':x['pm2_env']['restart_time']} for x in pm]
out['pass']=True;(D/'READBACK.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
