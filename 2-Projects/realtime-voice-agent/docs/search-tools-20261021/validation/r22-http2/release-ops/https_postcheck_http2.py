from pathlib import Path
import sys,subprocess,json
D=Path(__file__).parent;sys.path.insert(0,str(D.parent));from remote import command
code=r"""import pathlib,subprocess,json,time,urllib.request,urllib.error,urllib.parse,base64
pid=subprocess.check_output(['systemctl','show','p003-search-worker','-p','MainPID','--value'],text=True).strip();e=dict(x.split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_text().split('\0')if'='in x);base=e['LLM_BASE_URL'].rstrip('/');assert base.startswith('https://');token=urllib.parse.parse_qs(e['LLM_URL_QUERY'])['token'][0];claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='));assert claims['exp']>time.time()
headers={'authorization':'Bearer '+e['LLM_API_KEY'],'x-p003-worker-token':token};rows=[]
for sn,auth,want in [('BJP00326070803800006',True,200),('BJP00326060100100004',True,200),('BJP00399999999999902',True,403),('BJP00326070803800006',False,401)]:
 req=urllib.request.Request(base+'/internal/search-tasks/routing?'+urllib.parse.urlencode({'room':'sn-'+sn+'-'+str(int(time.time()))}),headers=headers if auth else {})
 try:
  with urllib.request.urlopen(req,timeout=8)as resp:status=resp.status;v=json.load(resp)
 except urllib.error.HTTPError as err:status=err.code;v=json.load(err)
 assert status==want,(sn,status,want);rows.append({'sn_suffix':sn[-8:],'authenticated':auth,'status':status,'routing_version':(v.get('snapshot')or{}).get('version'),'error':v.get('error')})
h=json.loads(pathlib.Path('/run/p003-search-canary/health.json').read_text());assert h['registered']and h['cleanup']['healthy'];print(json.dumps({'at_ms':int(time.time()*1000),'https':True,'worker_token_role':claims.get('role'),'worker_token_valid':True,'routes':rows,'health':h,'expiry_timer':subprocess.check_output(['systemctl','show','p003-search-expire-session13-20261026T031900Z.timer','-p','ActiveState','-p','NextElapseUSecRealtime'],text=True)}))
"""
p=subprocess.run(command('worker','python3 -'),input=code,text=True,capture_output=True,timeout=55);(D/'https-http2-postcheck.stderr').write_text(p.stderr);assert p.returncode==0,'HTTPS postcheck failed';v=json.loads(p.stdout);(D/'https-http2-postcheck.json').write_text(json.dumps(v));print(json.dumps(v))
