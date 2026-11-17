from pathlib import Path
import subprocess,json,hashlib,os,urllib.request,urllib.error,urllib.parse,time
D=Path('/root/p003-onboarding-release-20261117');release=json.loads((D/'WORKER-RELEASE.json').read_text());out={'at_ms':int(time.time()*1000),'units':{}}
for u in ['voice-worker-rust','p003-listening-worker','p003-search-worker']:
 s=dict(v.split('=',1)for v in subprocess.check_output(['systemctl','show',u,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines());s['sha256']=hashlib.sha256(Path('/proc',s['MainPID'],'exe').read_bytes()).hexdigest();out['units'][u]=s
s=out['units']['voice-worker-rust'];assert s['MainPID']==release['after']['MainPID']and s['NRestarts']==release['after']['NRestarts']and s['sha256']==release['new_sha'];out['stable_ms']=out['at_ms']-release['finished_ms']
for u,want in release['other_before'].items():assert all(out['units'][u][k]==v for k,v in want.items())
env=dict(os.fsdecode(x).split('=',1)for x in Path('/proc',s['MainPID'],'environ').read_bytes().split(b'\0')if b'='in x)
token=urllib.parse.parse_qs(env['LLM_URL_QUERY']).get('token',[''])[0];assert token
url=env['LLM_BASE_URL'].rstrip('/')+'/internal/voice-onboarding/v2/step';req=urllib.request.Request(url,data=b'{}',headers={'content-type':'application/json','x-p003-worker-token':token},method='POST');at=time.monotonic()
try:
 with urllib.request.urlopen(req,timeout=5)as r:res={'status':r.status,'body':json.load(r)}
except urllib.error.HTTPError as r:res={'status':r.code,'body':json.loads(r.read())}
res['elapsed_ms']=round((time.monotonic()-at)*1000,3);out['brain_auth_probe']=res
assert res['status']==400 and res['body']=={'error':'invalid_request','memory_write':'none'},'worker identity or route not accepted'
logs=subprocess.check_output(['journalctl','-u','voice-worker-rust','_PID='+s['MainPID'],'--since','@'+str(release['started_ms']//1000),'--no-pager','-o','cat'],text=True)
out['registration_count']=logs.count('registered worker');out['panic_count']=logs.count('panicked');assert out['registration_count']>=1 and out['panic_count']==0
assert out['units']['p003-listening-worker']['sha256']=='c7e70e77e4600e09b02f885101a17e8e7cea0e9635bc430d456b88081b6289d5'
assert out['units']['p003-search-worker']['sha256']=='c7bec7df92c47136fd0c91e5c2b4ed59c918ffa7158cdfb3a63415fa1e221b25'
out['success']=True;(D/'WORKER-POSTFLIGHT.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
