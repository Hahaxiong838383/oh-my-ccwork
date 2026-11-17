"""Run the frozen deployment candidate against its actual production Node versions, in isolation."""
from pathlib import Path
import hashlib,json,subprocess,sys,os,time
D=Path('/root/p003-history-identity-fix-20261117');R=D/'candidate'
node22='/usr/bin/node';node24='/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node'
names=['history-usage','history-observations','history-scope','history-gateway','history-dashboard','wechat-identity','wechat-client',
       'miniapp-admin','miniapp-unbind','mini008-dashboard','parent-conversations','telemetry','pairing',
       'sms-auth','sms-login-hardening','sms-login-http','ark-records','ark-records-legacy','ark-records-legacy-http',
       'ark-records-legacy-config','ark-records-legacy-summaries','ark-records-summaries']
out={'started_ms':int(time.time()*1000),'pass':False,'tests':[],'manifest_sha256':hashlib.sha256((D/'MANIFEST.json').read_bytes()).hexdigest()}
logs=D/'test-logs';logs.mkdir(exist_ok=True)
# Do not load production environment files. Tests must redirect every database into their own fixture.
env={k:v for k,v in os.environ.items() if not k.endswith('_DB_PATH') and not k.endswith('_SCOPE_JSON')}
for name,runtime in [(n,node22) for n in names]+[('ark-history',node24),('analytics-http',node24),('analytics-admin-auth',node24)]:
 p=logs/(name+'.log')
 with p.open('wb') as f:
  r=subprocess.run([runtime,'--experimental-sqlite','--import','tsx','scripts/'+name+'.test.ts'],cwd=R,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=90)
 out['tests'].append({'name':name,'runtime':Path(runtime).parent.name,'returncode':r.returncode,'log_sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 print(json.dumps(out['tests'][-1]),flush=True)
 if r.returncode:break
out['pass']=len(out['tests'])==len(names)+3 and all(x['returncode']==0 for x in out['tests'])
out['finished_ms']=int(time.time()*1000)
(D/'NODE22-TESTS.json').write_text(json.dumps(out,indent=2)+'\n')
sys.exit(0 if out['pass'] else 1)
