import pathlib,subprocess,sqlite3,json,os,sys,base64,hashlib,shutil,tarfile,time,urllib.request,importlib.util
P=json.loads(base64.b64decode(sys.stdin.readline()));os.umask(0o077)
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');R.mkdir(parents=True,exist_ok=True);R.chmod(0o700)
def cmd(a,t=300):
 p=subprocess.run(a,capture_output=True,timeout=t)
 if p.returncode:raise RuntimeError('command_failed')
 return p.stdout

def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def manifest(root):return {str(p.relative_to(root)):{'size':p.stat().st_size,'sha256':sha(p)} for p in root.rglob('*') if p.is_file() and not p.is_symlink()}
def save(n,o):(R/n).write_text(json.dumps(o,ensure_ascii=False))
assert not (R/'backup.json').exists()
O=pathlib.Path('/vol1/@appdata/oknote');C=pathlib.Path('/vol1/@appcenter/oknote')
state=json.loads(cmd(['docker','inspect','oknote']))[0];assert state['Image']=='sha256:aab435231ab37de91e588a997ce7f8b6321313a7f5b7ca007e33e72801324dc0'
save('oknote-container-private.json',state)
save('containers-before.json',json.loads(cmd(['docker','inspect']+cmd(['docker','ps','-aq']).decode().split())))
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
op.open(urllib.request.Request('http://192.168.1.115:38081/etapi/backup/before-oknote-20261023',method='PUT',headers={'Authorization':P['token']}),timeout=120).read()
tb=pathlib.Path('/vol1/1000/docker/trilium/backups/backup-before-oknote-20261023.db');assert tb.is_file();shutil.copy2(tb,R/tb.name)
shutil.copy2('/vol1/1000/docker/trilium/data/config.ini',R/'trilium-config-before.ini')
# Preserve all historical migration recovery files as part of the complete stopped snapshot.
guard='oknote-trilium-backup-guard'
gcode="import os,time,subprocess; p='/proc/"+str(os.getpid())+"';\nwhile os.path.exists(p): time.sleep(2)\nsubprocess.run(['docker','start','oknote'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)"
cmd(['systemd-run','--quiet','--unit',guard,'python3','-c',gcode]);cmd(['systemctl','is-active',guard])
try:
 cmd(['docker','stop','-t','30','oknote'])
 shutil.copytree(O/'data',R/'oknote-appdata/data',symlinks=True,dirs_exist_ok=True)
 src=sqlite3.connect(O/'data/oknote.db')
 dstpath=R/'oknote-appdata/data/oknote-consistent.db'; dst=sqlite3.connect(dstpath);src.backup(dst);dst.close();src.close()
 for suffix in ['-wal','-shm']:
  f=R/('oknote-appdata/data/oknote.db'+suffix)
  if f.exists():f.unlink()
 os.replace(dstpath,R/'oknote-appdata/data/oknote.db')
 shutil.copytree(C,R/'oknote-appcenter',symlinks=True,dirs_exist_ok=True)
 ma,mb=manifest(O),manifest(R/'oknote-appdata')
 save('snapshot-diff-private.json',[k for k in ma.keys()|mb.keys() if ma.get(k)!=mb.get(k)])
 assert all(k in ['data/oknote.db','data/oknote.db-wal','data/oknote.db-shm'] for k in ma.keys()|mb.keys() if ma.get(k)!=mb.get(k))
finally:
 cmd(['docker','start','oknote'])
 for _ in range(60):
  st=json.loads(cmd(['docker','inspect','oknote']))[0]
  if st['State'].get('Health',{}).get('Status')=='healthy':break
  time.sleep(2)
 assert st['State'].get('Health',{}).get('Status')=='healthy'
 cmd(['systemctl','stop',guard])
c=sqlite3.connect('file:'+str(R/'oknote-appdata/data/oknote.db')+'?immutable=1',uri=True);assert c.execute('pragma integrity_check').fetchone()[0]=='ok';c.close()
m=manifest(R/'oknote-appdata');save('source-files-private.json',m)
archive=R/'oknote-complete.tar.gz'
with tarfile.open(archive,'w:gz',compresslevel=1) as t:
 for name in ['oknote-appdata','oknote-appcenter','oknote-container-private.json']:t.add(R/name,arcname=name)
observed={}
with tarfile.open(archive,'r:gz') as t:
 for x in t:
  if x.isfile() and x.name.startswith('oknote-appdata/'):
   observed[x.name.removeprefix('oknote-appdata/')]={'size':x.size,'sha256':hashlib.file_digest(t.extractfile(x),'sha256').hexdigest()}
assert observed==m
cmd(['docker','save','-o',str(R/'oknote-image.tar'),state['Image']],600)
report={'complete':True,'files':len(m),'bytes':sum(v['size'] for v in m.values()),'archive_sha256':sha(archive),'archive_bytes':archive.stat().st_size,'trilium_backup_sha256':sha(tb),'image_archive_sha256':sha(R/'oknote-image.tar'),'source_db_integrity':'ok','archive_members_verified':True,'source_restarted':True}
save('backup.json',report);print(json.dumps(report))
