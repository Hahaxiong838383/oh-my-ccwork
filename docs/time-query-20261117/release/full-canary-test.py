from pathlib import Path
import subprocess,json,os,time,socket,urllib.request
D=Path('/root/p003-clock-release-20261117');rows=[]
for i in (1,2):
 s=D/'verify'/str(i)/'2-Projects/P003GameDemo20260513/apps/server'
 with socket.socket() as sk:sk.bind(('127.0.0.1',0));port=sk.getsockname()[1]
 sn='BJP0039912319999000'+str(i)
 env={'PATH':'/usr/bin:/bin','HOME':'/root','PORT':str(port),'SEARCH_CANARY_ROOT':str(s),'SEARCH_CANARY_SN':sn,'SEARCH_CANARY_MAX_JOBS':'1','SEARCH_WORKER_ACCOUNT_ID':'search-canary-worker','AUTH_JWT_SECRET':'isolated-clock-authority','CUSTOM_LLM_API_KEY':'isolated-clock-key','CLOCK_ISOLATED_FULL':'1','CLOCK_PROBE_SN':sn,'CLOCK_PROBE_RESULT':str(D/f'FULL-CANARY-{i}.json'),'LLM_PROVIDER':'deepseek','DEEPSEEK_API_KEY':'synthetic-unused'}
 seed="import {prepareCanaryEnvironment} from './src/search-canary-guard.js';prepareCanaryEnvironment(process.env);const {configStore}=await import('./src/config-store.js');configStore.setFlag('p003.search.canary.expires_at_ms',String(Date.now()+600000),'synthetic-full-entry');process.exit(0);"
 (s/'clock-seed.ts').write_text(seed)
 r=subprocess.run(['/usr/bin/node','--experimental-sqlite','--import','tsx','clock-seed.ts'],cwd=s,env=env,capture_output=True,timeout=30);assert r.returncode==0,r.stderr.decode()[-1500:]
 log=(D/f'FULL-CANARY-{i}.log').open('wb');child=subprocess.Popen(['/usr/bin/node','--experimental-sqlite','--import','tsx','src/search-canary-main.ts'],cwd=s,env=env,stdout=log,stderr=log)
 try:
  ready=False
  for _ in range(60):
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=1) as h:ready=h.status==200
    if ready:break
   except Exception:time.sleep(.2)
  assert ready,'isolated full server not ready'
  with (D/f'FULL-CANARY-{i}-probe.log').open('wb') as f:r=subprocess.run(['/usr/bin/node','--experimental-sqlite',str(D/'live-clock-probe.mjs')],cwd=s,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=45)
  result=json.loads((D/f'FULL-CANARY-{i}.json').read_text());rows.append({'pool':i,'exit':r.returncode,'result':result});assert r.returncode==0 and result['pass'] and result['cleanup'],result
 finally:child.terminate();child.wait(timeout=15);log.close()
(D/'FULL-CANARY-TESTS.json').write_text(json.dumps({'pass':True,'rows':rows,'synthetic':True,'production_data_used':False},indent=2)+'\n')
