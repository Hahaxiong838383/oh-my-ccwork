import pathlib,json,sys,base64,subprocess,os,shutil,urllib.request,time,hashlib,sqlite3
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');P=json.loads(base64.b64decode(sys.stdin.readline()));assert json.loads((R/'verification.json').read_text())['complete'];os.umask(0o077)
op=urllib.request.build_opener(urllib.request.ProxyHandler({}));op.open(urllib.request.Request('http://192.168.1.115:38081/etapi/backup/after-oknote-20261023',method='PUT',headers={'Authorization':P['token']}),timeout=180).read()
b=pathlib.Path('/vol1/1000/docker/trilium/backups/backup-after-oknote-20261023.db');assert b.is_file();shutil.copy2(b,R/b.name)
S=R/'restore-trilium';S.mkdir(exist_ok=False);(S/'data').mkdir();(S/'backups').mkdir();shutil.copy2(b,S/'data/document.db');shutil.copy2('/vol1/1000/docker/trilium/data/config.ini',S/'data/config.ini')
for p in [S,*S.rglob('*')]:os.chown(p,1000,1001)
state=json.loads(subprocess.check_output(['docker','inspect','trilium']))[0];name='trilium-migration-restore'
def cmd(a,inp=None,timeout=300):
 p=subprocess.run(a,input=inp,capture_output=True,timeout=timeout);assert p.returncode==0;return p.stdout
try:
 cmd(['docker','run','-d','--name',name,'--network','none','-e','TRILIUM_DATA_DIR=/home/node/trilium-data','-e','TRILIUM_BACKUP_DIR=/home/node/trilium-backups','-v',str(S/'data')+':/home/node/trilium-data','-v',str(S/'backups')+':/home/node/trilium-backups',state['Image']])
 for _ in range(60):
  p=subprocess.run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:8080/api/health-check').then(r=>process.exit(r.ok?0:2)).catch(()=>process.exit(3))"],capture_output=True)
  if p.returncode==0:break
  time.sleep(2)
 assert p.returncode==0
 L=json.loads((R/'import-ledger-private.json').read_text());checks=[]
 for rec in list(L['finished'].values())+list(L['versions'].values()):checks.append({'path':'notes/'+rec['id']+'/content','sha256':rec['sha256']})
 for a in L['attachments'].values():checks.append({'path':'attachments/'+a['id']+'/content','sha256':a['sha256']})
 js="let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',async()=>{try{let p=JSON.parse(s),good=0;for(let c of p.checks){let r=await fetch('http://127.0.0.1:8080/etapi/'+c.path,{headers:{Authorization:p.token}});if(!r.ok)throw 1;let b=Buffer.from(await r.arrayBuffer());if(require('crypto').createHash('sha256').update(b).digest('hex')!==c.sha256)throw 2;good++}console.log(JSON.stringify({verified:good}))}catch(e){console.log(JSON.stringify({error:'restore_payload_mismatch'}));process.exit(1)}})"
 out=json.loads(cmd(['docker','exec','-i',name,'node','-e',js],json.dumps({'token':P['token'],'checks':checks}).encode(),timeout=1800));assert out['verified']==len(checks)
 db=sqlite3.connect('file:'+str(S/'data/document.db')+'?mode=ro',uri=True);assert db.execute('pragma integrity_check').fetchone()[0]=='ok';db.close()
 report={'restored_application_healthy':True,'network':'none','verified_payloads':out['verified'],'backup_bytes':b.stat().st_size,'backup_sha256':hashlib.file_digest(b.open('rb'),'sha256').hexdigest(),'database_integrity':'ok'};(R/'target-restore.json').write_text(json.dumps(report));print(json.dumps(report))
finally:subprocess.run(['docker','rm','-f',name],capture_output=True)
