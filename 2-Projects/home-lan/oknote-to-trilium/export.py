import json,pathlib,sqlite3,subprocess,sys,base64,collections,re,hashlib,os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');D=R/'oknote-appdata/data';E=R/'export';os.umask(0o077)
assert (D/'oknote.db').is_file()
E.mkdir(exist_ok=True)
st=json.loads((R/'oknote-container-private.json').read_text());env=dict(s.split('=',1) for s in st['Config']['Env'] if '=' in s)
key=env.get('ENCRYPTION_KEY')
if not key:
 for p in [R/'oknote-appdata/.env',D/'.secrets.env']:
  if p.exists():
   for s in p.read_text().splitlines():
    if s.startswith('ENCRYPTION_KEY='):key=s.split('=',1)[1].strip().strip('\"\'')
assert key and re.fullmatch('[a-fA-F0-9]{64}',key)
aes=AESGCM(bytes.fromhex(key))
def plain(raw):
 p=pathlib.PurePosixPath(raw)
 if p.is_absolute():
  for pre in ['/app/data','/app/legacy','/vol1/@appdata/oknote/data']:
   try:p=p.relative_to(pre);break
   except ValueError:pass
 assert not p.is_absolute() and '..' not in p.parts
 b=(D/str(p)).read_bytes();return aes.decrypt(b[:12],b[28:]+b[12:28],None)
c=sqlite3.connect('file:'+str(D/'oknote.db')+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
rows={t:[dict(x) for x in c.execute('select * from '+t)] for t in ['shelves','notebooks','notes','attachments','versions','tags','note_tags','note_links','tasks']}
(E/'metadata.json').write_text(json.dumps(rows,ensure_ascii=False))
counts=collections.Counter();marks=collections.Counter();attrs=collections.defaultdict(set);formats=collections.Counter();schemas={};report={}
def walk(n):
 if not isinstance(n,dict):return
 t=n.get('type');counts[t]+=1;attrs[t].update((n.get('attrs') or {}).keys())
 for m in n.get('marks',[]):marks[m['type']]+=1;attrs['mark:'+m['type']].update((m.get('attrs') or {}).keys())
 for x in n.get('content',[]):walk(x)
for t,pathcol in [('notes','content_path'),('attachments','filepath'),('versions','content_path')]:
 (E/t).mkdir(exist_ok=True)
 if t=='versions' and rows[t]:
  schemas['versions']=list(rows[t][0]);pathcol=next(k for k in rows[t][0] if 'path' in k)
 for i,row in enumerate(rows[t]):
  b=plain(row[pathcol]);ident=str(row.get('id',i));assert re.fullmatch('[A-Za-z0-9_-]+',ident)
  (E/t/ident).write_bytes(b);row['export_sha256']=hashlib.sha256(b).hexdigest();row['export_bytes']=len(b)
  if t=='attachments':
   assert len(b)==row['size'];assert not row.get('content_hash') or hashlib.sha256(b).hexdigest()==row['content_hash']
  if t=='notes':
   s=b.decode();m=re.match(r'\s*<!-- oknote:json:([^ ]+) -->',s)
   if m:doc=json.loads(base64.b64decode(m[1]));walk(doc);formats['tiptap']+=1
   elif row['type']=='mindmap':
    j=json.loads(s);schemas['mindmap']=list(j);schemas['mindmap_root']=list(j.get('root',{}));formats['mindmap']+=1
   else:formats['plain_or_markdown']+=1
 report[t]=len(rows[t])
(E/'metadata.json').write_text(json.dumps(rows,ensure_ascii=False))
report.update({'formats':dict(formats),'node_types':dict(counts),'mark_types':dict(marks),'attribute_keys':{k:sorted(v) for k,v in attrs.items()},'schemas':schemas,'encrypted_notebooks':sum(bool(x['is_encrypted']) for x in rows['notebooks'])})
(R/'export-summary.json').write_text(json.dumps(report));print(json.dumps(report))
