import pathlib,tarfile,subprocess,json,os,time,hashlib,sqlite3,base64,hmac
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');S=R/'restore-oknote';os.umask(0o077)
assert json.loads((R/'backup.json').read_text())['complete'];S.mkdir(exist_ok=True)
with tarfile.open(R/'oknote-complete.tar.gz','r:gz') as t:
 for m in t:
  if m.name.startswith(('oknote-appdata/data/','oknote-appdata/config/')) or m.name in ['oknote-appdata/data','oknote-appdata/config','oknote-container-private.json']:
   assert not m.issym() and not m.islnk() and '..' not in pathlib.PurePosixPath(m.name).parts;t.extract(m,S)
st=json.loads((S/'oknote-container-private.json').read_text());ef=S/'env';ef.write_text('\n'.join(st['Config']['Env'])+'\n')
def cmd(a,inp=None,t=120):
 p=subprocess.run(a,input=inp,capture_output=True,timeout=t)
 assert p.returncode==0
 return p.stdout
env=dict(x.split('=',1) for x in st['Config']['Env'] if '=' in x)
port=next(iter(st['HostConfig']['PortBindings'])).split('/')[0]
name='oknote-migration-restore'
try:
 cmd(['docker','run','-d','--name',name,'--network','none','--env-file',str(ef),'-v',str(S/'oknote-appdata/data')+':/app/data','-v',str(S/'oknote-appdata/data')+':/app/legacy','-v',str(S/'oknote-appdata/config')+':/app/config',st['Image']]);ef.unlink()
 health=False
 for _ in range(60):
  p=subprocess.run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:"+port+"/api/health').then(r=>r.json()).then(x=>process.exit(x.ok?0:2)).catch(()=>process.exit(3))"],capture_output=True)
  if p.returncode==0:health=True;break
  time.sleep(2)
 # Actual port comes from immutable container configuration, not a guessed UI host mapping.
 if not health:
  env=dict(x.split('=',1) for x in st['Config']['Env'] if '=' in x)
  port=env.get('PORT','3000')
  health=json.loads(cmd(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:"+port+"/api/health').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"]))['ok']
 assert health
 env=dict(x.split('=',1) for x in st['Config']['Env'] if '=' in x)
 c=sqlite3.connect(S/'oknote-appdata/data/oknote.db');uid=c.execute('select id from users').fetchone()[0];c.close()
 def enc(x):return base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).decode().rstrip('=')
 ts=int(time.time());tok=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'uid':uid,'typ':'access','iat':ts,'exp':ts+120,'sid':'migration-restore'})
 tok+='.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),tok.encode(),hashlib.sha256).digest()).decode().rstrip('=')
 meta=json.loads((R/'export/metadata.json').read_text());samples=[]
 for typ in ['notes','attachments']:
  rows=meta[typ][:3]
  for row in rows:
   script="let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',async()=>{let p=JSON.parse(s);let r=await fetch(p.url,{headers:{Authorization:'Bearer '+p.token}});if(!r.ok)process.exit(2);let b=p.kind==='notes'?Buffer.from((await r.json()).content):Buffer.from(await r.arrayBuffer());console.log(JSON.stringify({sha256:require('crypto').createHash('sha256').update(b).digest('hex')}))})"
   out=json.loads(cmd(['docker','exec','-i',name,'node','-e',script],json.dumps({'url':'http://127.0.0.1:'+port+'/api/'+typ+'/'+row['id'],'token':tok,'kind':typ}).encode()))
   assert out['sha256']==row['export_sha256'];samples.append(typ)
 report={'isolated_network':'none','restored_from_archive':True,'application_healthy':True,'body_samples':samples.count('notes'),'attachment_samples':samples.count('attachments')};(R/'source-restore.json').write_text(json.dumps(report));print(json.dumps(report))
finally:
 subprocess.run(['docker','rm','-f',name],capture_output=True)
 if ef.exists():ef.unlink()
