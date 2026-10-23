"""Retire OKnote only after all migration and actual restore gates pass."""
import pathlib,json,subprocess,sqlite3,hashlib,shutil,os,time,socket
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');SRC=pathlib.Path('/vol1/@appdata/oknote')
for file,field in [('backup.json','complete'),('verification.json','complete'),('source-restore.json','application_healthy'),('target-restore.json','restored_application_healthy'),('browser-result.json','complete')]:assert json.loads((R/file).read_text())[field]
M=json.loads((R/'export/metadata.json').read_text());before=json.loads((R/'containers-before.json').read_text())
def cmd(a,inp=None,t=300):
 p=subprocess.run(a,input=inp,capture_output=True,text=True,timeout=t)
 if p.returncode:raise RuntimeError('command_failed_'+a[0])
 return p.stdout
cmd(['docker','stop','-t','30','oknote'])
try:
 c=sqlite3.connect('file:'+str(SRC/'data/oknote.db')+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 for table in M:
  cols=[x[1] for x in c.execute('pragma table_info('+table+')')]
  actual=[dict(x) for x in c.execute('select * from '+table)];expected=[{k:x[k] for k in cols} for x in M[table]]
  normalize=lambda a:sorted(json.dumps(x,sort_keys=True,ensure_ascii=False) for x in a)
  assert normalize(actual)==normalize(expected),'source_changed_after_migration'
 c.close()
 files=json.loads((R/'source-files-private.json').read_text())
 for path,v in files.items():
  if path.startswith(('data/notes/','data/mindmaps/','data/whiteboards/','data/attachments/','data/versions/')):
   p=SRC/path;assert p.is_file() and hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==v['sha256']
 (R/'retirement-frozen.json').write_text(json.dumps({'source_unchanged':True,'stopped':True}))
except BaseException:
 cmd(['docker','start','oknote']);raise
# Native manager maintains registry, package paths, desktop entry and service ownership.
p=subprocess.run(['/usr/local/bin/appcenter-cli','uninstall','oknote'],input='y\n',capture_output=True,text=True,timeout=300)
(R/'native-uninstall-private.log').write_text(p.stdout+'\n'+p.stderr)
assert p.returncode==0,'native_uninstall_failed'
listing=cmd(['/usr/local/bin/appcenter-cli','list']);assert 'oknote' not in listing.lower(),'application_registry_still_present'
assert subprocess.run(['docker','inspect','oknote'],capture_output=True).returncode!=0,'source_container_still_present'
ids=cmd(['docker','ps','-aq']).split();current=json.loads(cmd(['docker','inspect']+ids))
for c in current:
 assert not any(m['Source'].startswith(str(SRC)) for m in c['Mounts']),'source_storage_still_mounted'
if SRC.exists():
 assert SRC.is_dir() and not SRC.is_symlink() and not os.path.ismount(SRC)
 assert not any(p.is_symlink() or (p.is_dir() and os.path.ismount(p)) for p in SRC.rglob('*'))
 shutil.rmtree(SRC)
assert not SRC.exists()
# Keep every other application and the new target unchanged.
expected={c['Name']:c for c in before if c['Name']!='/oknote'};actual={c['Name']:c for c in current}
assert set(expected)==set(actual),'other_container_set_changed'
for name,c in expected.items():
 a=actual[name];assert a['Id']==c['Id'] and a['Image']==c['Image'] and a['HostConfig']['PortBindings']==c['HostConfig']['PortBindings']
assert actual['/trilium']['State'].get('Health',{}).get('Status')=='healthy'
image=json.loads((R/'oknote-container-private.json').read_text())['Image'];consumers=[c for c in current if c['Image']==image]
image_removed=False
if not consumers:
 p=subprocess.run(['docker','image','rm',image],capture_output=True,text=True);image_removed=subprocess.run(['docker','image','inspect',image],capture_output=True).returncode!=0
s=socket.socket();s.settimeout(3);closed=s.connect_ex(('127.0.0.1',38080))!=0;s.close();assert closed
report={'uninstalled':True,'app_registry_absent':True,'container_absent':True,'runtime_data_removed':True,'port_38080_closed':True,'other_containers_preserved':len(expected),'trilium_healthy':True,'unused_image_removed':image_removed,'backup_directory':str(R),'package_directory_absent':not pathlib.Path('/vol1/@appcenter/oknote').exists(),'app_entry_absent':not pathlib.Path('/var/apps/oknote').exists()}
(R/'retirement.json').write_text(json.dumps(report));print(json.dumps(report))
