import pathlib,json,sys,base64,urllib.request,subprocess,hashlib,sqlite3,shutil
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');P=json.loads(base64.b64decode(sys.stdin.readline()));L=json.loads((R/'import-ledger-private.json').read_text());ret=json.loads((R/'retirement.json').read_text());assert ret['uninstalled']
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def get(path):return op.open(urllib.request.Request('http://192.168.1.115:38081/etapi/'+path,headers={'Authorization':P['token']}),timeout=120).read()
app=json.loads(get('app-info'));assert app['appVersion']=='0.106.0'
samples=json.loads((R/'ui-samples-private.json').read_text())
for s in samples:assert hashlib.sha256(get('notes/'+s['id']+'/content')).hexdigest()==s['hash']
for a in list(L['attachments'].values())[:3]:assert hashlib.sha256(get('attachments/'+a['id']+'/content')).hexdigest()==a['sha256']
c=sqlite3.connect('file:/vol1/1000/docker/trilium/data/document.db?mode=ro',uri=True);assert c.execute('pragma quick_check').fetchone()[0]=='ok'
for nid in L['notes'].values():assert c.execute('select isDeleted from notes where noteId=?',(nid,)).fetchone()==(0,)
for a in L['attachments'].values():assert c.execute('select isDeleted from attachments where attachmentId=?',(a['id'],)).fetchone()==(0,)
c.close()
cs=json.loads(subprocess.check_output(['docker','inspect']+subprocess.check_output(['docker','ps','-aq'],text=True).split()))
for name in ['restore-oknote','restore-trilium']:
 d=R/name
 assert not any(m['Source'].startswith(str(d)) for x in cs for m in x['Mounts'])
 if d.exists():assert d.is_dir() and not d.is_symlink();shutil.rmtree(d)
report={'post_uninstall_target_healthy':True,'imported_tree_nodes_present':len(L['notes']),'imported_attachments_present':len(L['attachments']),'post_uninstall_note_payload_samples':len(samples),'post_uninstall_attachment_payload_samples':3,'database_integrity':'ok','temporary_restore_copies_removed':True}
(R/'post-uninstall-check.json').write_text(json.dumps(report))
files=['backup.json','conversion-preflight.json','verification.json','source-restore.json','target-restore.json','browser-result.json','retirement.json','post-uninstall-check.json'];print(json.dumps({n:json.loads((R/n).read_text()) for n in files}))
