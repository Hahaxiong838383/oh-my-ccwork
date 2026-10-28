from pathlib import Path
import json,sys,subprocess
D=Path(__file__).parent;sys.path.insert(0,str(D.parent));from remote import command
label=sys.argv[1];assert label in ['initial','final'];spec=json.loads((D/'release-http2-spec.json').read_text());session=json.loads((D/'release-http2-session.json').read_text());assert (D/'release-http2-brain-open.json').exists()
programs={
'worker':r'''import pathlib,json,subprocess,hashlib,time
r=pathlib.Path('/opt/p003-search-canary-20261021');b=r/'backups'/__LABEL__;spec=__SPEC__;snap=json.loads((b/'manifest.json').read_text());installed=json.loads((b/'r22-install.json').read_text())
def unit(name):return subprocess.check_output(['systemctl','show',name,'-p','MainPID','-p','NRestarts','-p','ActiveState'],text=True)
assert unit('voice-worker-rust')==snap['units']['voice-worker-rust'];u=unit('p003-search-worker');vals=dict(x.split('=',1)for x in u.splitlines());pid=vals['MainPID'];assert pid==installed['pid']and vals['ActiveState']=='active'and vals['NRestarts']=='0';assert hashlib.sha256(pathlib.Path('/proc',pid,'exe').read_bytes()).hexdigest()==spec['worker_sha256']
e=dict(x.decode().split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x);assert all(e.get(k)==v for k,v in spec['worker_env_changes'].items())
w=json.loads((r/'window.json').read_text());assert w==snap['window'];h=json.loads(pathlib.Path('/run/p003-search-canary/health.json').read_text());assert h['registered']and h['cleanup']['healthy']and 0<=h['jobs']<=int(e['WORKER_MAX_JOBS'])and time.time()*1000-h['at_ms']<12000
print(json.dumps({'at_ms':int(time.time()*1000),'unit':u,'worker_sha256':spec['worker_sha256'],'main_process_unchanged':True,'runtime_env_verified':True,'window':w,'health':h}))
''',
'brain':r'''import pathlib,json,subprocess,hashlib,time,sqlite3,urllib.request
r=pathlib.Path('/opt/p003/search-canary-20261021/brain');b=pathlib.Path('/opt/p003/backups')/__LABEL__;spec=__SPEC__;snap=json.loads((b/'manifest.json').read_text());installed=json.loads((b/'r22-install.json').read_text());main=pathlib.Path('/opt/p003/server')
main_now=[[p['name'],p['pid'],p['pm2_env']['restart_time']]for p in json.loads(subprocess.check_output(['pm2','jlist'],text=True))];assert main_now==snap['main_processes'];assert hashlib.sha256((main/'src/tools/search-executor.ts').read_bytes()).hexdigest()==snap['main_executor_sha256'];assert all(hashlib.sha256((r/n).read_bytes()).hexdigest()==h for n,h in spec['source'].items())
u=subprocess.check_output(['systemctl','show','p003-search-brain','-p','MainPID','-p','NRestarts','-p','ActiveState'],text=True);vals=dict(x.split('=',1)for x in u.splitlines());assert vals['MainPID']==installed['pid']and vals['ActiveState']=='active'and vals['NRestarts']=='0'
for root,k in [(main,'main_flags'),(r,'candidate_flags')]:
 c=sqlite3.connect('file:'+str(root/'data/config.db')+'?mode=ro',uri=True);f=dict(c.execute("select key,value from runtime_flag where key like 'p003.search.%'"));c.close();assert f==snap[k]
h=json.load(urllib.request.urlopen('http://127.0.0.1:3007/health',timeout=3));assert h['status']=='ok'and h['search']and h['tools'];rel=json.loads((r/'release-status.json').read_text());assert rel['worker_sha256']==spec['worker_sha256']and rel['revision']==spec['revision']
print(json.dumps({'at_ms':int(time.time()*1000),'unit':u,'main_processes_unchanged':True,'source_verified':True,'scope_and_deadline_unchanged':True,'health':h,'revision':rel['revision']}))
'''}
result={}
for host,code in programs.items():
 code=code.replace('__LABEL__',repr(session['label'])).replace('__SPEC__',repr(spec));compile(code,host,'exec');x=subprocess.run(command(host,'python3 -'),input=code,text=True,capture_output=True,timeout=55);(D/('http2-observe-'+label+'-'+host+'.stderr')).write_text(x.stderr);assert x.returncode==0,'post release observation failed '+host;result[host]=json.loads(x.stdout)
if label=='final':
 before=json.loads((D/'http2-observe-initial.json').read_text());assert all(result[h]['at_ms']-before[h]['at_ms']>=180000 for h in programs),'observation interval under three minutes'
p=D/('http2-observe-'+label+'.json');assert not p.exists();p.write_text(json.dumps(result,indent=2));p.chmod(0o600);print(json.dumps(result))
