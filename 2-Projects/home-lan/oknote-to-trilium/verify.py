import pathlib,json,sys,base64,sqlite3,hashlib,urllib.request,collections,re
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');P=json.loads(base64.b64decode(sys.stdin.readline()));L=json.loads((R/'import-ledger-private.json').read_text());M=json.loads((R/'export/metadata.json').read_text());op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def get(path,binary=False):
 b=op.open(urllib.request.Request('http://192.168.1.115:38081/etapi'+path,headers={'Authorization':P['token']}),timeout=180).read();return b if binary else json.loads(b)
def sha(b):return hashlib.sha256(b).hexdigest()
assert len(L['finished'])==len(M['notes']) and len(L['versions'])==len(M['versions'])
links=0;refs=set();samples=[]
for old,rec in L['finished'].items():
 b=get('/notes/'+rec['id']+'/content',True);assert sha(b)==rec['sha256'];s=b.decode()
 for target in re.findall(r'href="#root/([A-Za-z0-9_]+)"',s):assert target in L['notes'].values();links+=1
 for aid in re.findall(r'(?:src|href)="api/attachments/([A-Za-z0-9_]+)/',s):assert aid in {a['id'] for a in L['attachments'].values()};refs.add(aid)
 samples.append({'id':rec['id'],'images':s.count('<img '),'tables':s.count('<table>'),'tasks':s.count('type="checkbox"'),'math':s.count('math-tex'),'chars':len(s),'hash':rec['sha256']})
for rec in L['versions'].values():assert sha(get('/notes/'+rec['id']+'/content',True))==rec['sha256']
for a in L['attachments'].values():
 assert a['uploaded'];b=get('/attachments/'+a['id']+'/content',True);assert len(b)==a['bytes'] and sha(b)==a['sha256']
base=sqlite3.connect('file:'+str(R/'backup-before-oknote-20261023.db')+'?mode=ro',uri=True);live=sqlite3.connect('file:/vol1/1000/docker/trilium/data/document.db?mode=ro',uri=True)
assert live.execute('pragma quick_check').fetchone()[0]=='ok'
# Compare original user notes and attached blobs, without exposing their content or titles.
cols=['noteId','title','type','mime','isProtected','isDeleted','blobId']
old=base.execute('select '+','.join(cols)+' from notes').fetchall();preserved=0
for row in old:
 current=live.execute('select '+','.join(cols)+' from notes where noteId=?',(row[0],)).fetchone();assert current==row,'existing_target_note_changed'
 if row[-1]:
  a=base.execute('select content from blobs where blobId=?',(row[-1],)).fetchone();b=live.execute('select content from blobs where blobId=?',(row[-1],)).fetchone();assert a==b
 preserved+=1
for table,idcol in [('attachments','attachmentId'),('attributes','attributeId')]:
 cols=[x[1] for x in base.execute('pragma table_info('+table+')')];rows=base.execute('select * from '+table).fetchall()
 for row in rows:
  key=row[cols.index(idcol)];current=live.execute('select * from '+table+' where '+idcol+'=?',(key,)).fetchone();assert current==row,'existing_target_metadata_changed'
old_options=dict(base.execute('select name,value from options'));current_options=dict(live.execute('select name,value from options'));changed_options=[k for k,v in old_options.items() if current_options.get(k)!=v]
assert pathlib.Path('/vol1/1000/docker/trilium/data/config.ini').read_bytes()==(R/'trilium-config-before.ini').read_bytes()
# Verify source did not change since snapshot. Volatile sessions / WAL are intentionally not content.
src=sqlite3.connect('file:/vol1/@appdata/oknote/data/oknote.db?mode=ro',uri=True);src.row_factory=sqlite3.Row
for table in M:
 cols=[x[1] for x in src.execute('pragma table_info('+table+')')]
 actual=[{k:dict(x)[k] for k in cols} for x in src.execute('select * from '+table)]
 expected=[{k:x[k] for k in cols} for x in M[table]]
 sort=lambda rows:sorted(json.dumps(x,sort_keys=True,ensure_ascii=False) for x in rows)
 assert sort(actual)==sort(expected),'source_changed_since_export'
# Check body/attachment encrypted bytes against the snapshot (only live data, no old archives).
files=json.loads((R/'source-files-private.json').read_text());checked=0
for k,v in files.items():
 if k.startswith(('data/notes/','data/mindmaps/','data/whiteboards/','data/attachments/','data/versions/')):
  p=pathlib.Path('/vol1/@appdata/oknote')/k;assert p.is_file() and hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==v['sha256'];checked+=1
selected=[]
for key in ['images','tables','tasks','math','chars']:
 s=max(samples,key=lambda r:r[key])
 if s not in selected:selected.append(s)
(R/'ui-samples-private.json').write_text(json.dumps(selected))
report={'complete':True,'source_notes':len(M['notes']),'active_source_notes':sum(not x['is_deleted'] for x in M['notes']),'source_attachments':len(M['attachments']),'total_verified_attachments':len(L['attachments']),'historical_versions':len(L['versions']),'source_shelves':len(M['shelves']),'source_notebooks':len(M['notebooks']),'source_tags':len(M['tags']),'tag_assignments':len(M['note_tags']),'internal_links':links,'original_target_notes_preserved':preserved,'trilium_config_preserved':True,'changed_option_names':changed_options,'source_unchanged':True,'source_files_rehashed':checked,'trilium_database_integrity':'ok'}
(R/'verification.json').write_text(json.dumps(report));print(json.dumps(report))
