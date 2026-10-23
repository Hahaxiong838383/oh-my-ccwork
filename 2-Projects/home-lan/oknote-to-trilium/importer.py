"""NAS-only resumable OKnote -> Trilium ETAPI importer. Private ledger never leaves NAS."""
import sys,pathlib,json,base64,hashlib,urllib.request,urllib.error,datetime,os,sqlite3,collections,re,time
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');sys.path[:0]=[str(R/'tools'),str(R/'tools/vendor')]
from convert import Converter,assert_text_preserved
os.umask(0o077);P=json.loads(base64.b64decode(sys.stdin.readline()));TOKEN=P['token'];BASE='http://192.168.1.115:38081/etapi';op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(path,method='GET',data=None,binary=False):
 ct='application/json'
 if isinstance(data,bytes):ct='application/octet-stream'
 elif data is not None:data=json.dumps(data,ensure_ascii=False).encode()
 req=urllib.request.Request(BASE+path,data=data,method=method,headers={'Authorization':TOKEN,'Content-Type':ct})
 try:
  with op.open(req,timeout=180) as r:b=r.read()
 except urllib.error.HTTPError as e:raise RuntimeError('etapi_http_'+str(e.code)) from None
 return b if binary else (json.loads(b) if b else None)
def sha(b):return hashlib.sha256(b).hexdigest()
def save(path,o):
 tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(o,ensure_ascii=False));os.replace(tmp,path)
def ident(kind,old):return 'ok'+kind+sha(old.encode())[:24]
assert (R/'source-files-private.json').is_file() and (R/'backup-before-oknote-20261023.db').is_file()
sc=sqlite3.connect('file:'+str(R/'oknote-appdata/data/oknote.db')+'?immutable=1',uri=True);assert sc.execute('pragma integrity_check').fetchone()[0]=='ok';sc.close()
assert json.loads((R/'conversion-preflight.json').read_text())['notes_converted']==405
M=json.loads((R/'export/metadata.json').read_text());LP=R/'import-ledger-private.json'
L=json.loads(LP.read_text()) if LP.exists() else {'notes':{},'attachments':{},'finished':{},'versions':{},'attributes':[]}
def progress(stage):
 save(LP,L);save(R/'import-progress.json',{'stage':stage,'tree_nodes':len(L['notes']),'attachments':len(L['attachments']),'finished_notes':len(L['finished']),'versions':len(L['versions'])})
def note(key,parent,title,content='',position=10):
 nid=ident('n',key)
 if key in L['notes']:return L['notes'][key]
 # Deterministic IDs allow recovery if the POST response was lost.
 try:
  prior=api('/notes/'+nid);assert prior['title']==(title or '（无标题）') and parent in prior['parentNoteIds']
 except RuntimeError as e:
  if str(e)!='etapi_http_404':raise
  out=api('/create-note','POST',{'noteId':nid,'parentNoteId':parent,'title':title or '（无标题）','type':'text','mime':'text/html','content':content,'notePosition':int(position or 10)})
  assert out['note']['noteId']==nid
 L['notes'][key]=nid;progress('tree');return nid
def attachment(key,owner,name,mime,data):
 digest=sha(data)
 if key in L['attachments']:
  a=L['attachments'][key];assert a['sha256']==digest
 else:
  a=api('/attachments','POST',{'ownerId':owner,'role':'image' if mime.startswith('image/') else 'file','mime':mime,'title':name,'position':10})
  a={'id':a['attachmentId'],'owner':owner,'name':name,'sha256':digest,'bytes':len(data),'uploaded':False};L['attachments'][key]=a;progress('attachments')
 if not a['uploaded']:
  api('/attachments/'+a['id']+'/content','PUT',data)
  b=api('/attachments/'+a['id']+'/content',binary=True);assert len(b)==len(data) and sha(b)==digest
  a['uploaded']=True;progress('attachments')
 return a
def attr(nid,name,value=''):
 key=nid+'|'+name+'|'+value
 if key in L['attributes']:return
 old=api('/notes/'+nid)['attributes']
 if not any(x['type']=='label' and x['name']==name and x['value']==value for x in old):api('/attributes','POST',{'noteId':nid,'type':'label','name':name,'value':value,'isInheritable':False})
 L['attributes'].append(key);progress('attributes')
root=note('migration-root','root','OK笔记迁移（2026-10-23）','<p>原书架、笔记本、正文、附件和标签保留于此。每篇笔记附有原始正文；原回收站与历史版本单独保留。思维导图转为可编辑大纲，并保留原始 JSON。</p>')
for row in sorted(M['shelves'],key=lambda r:r['sort_order'] or 0):note('shelf:'+row['id'],root,row['name'],position=row['sort_order'])
pending=list(M['notebooks'])
while pending:
 before=len(pending)
 for row in list(pending):
  key='book:'+row['id'];pk='book:'+row['parent_id'] if row['parent_id'] else 'shelf:'+row['shelf_id']
  if pk not in L['notes']:continue
  note(key,L['notes'][pk],row['name'],position=row['sort_order']);pending.remove(row)
 assert len(pending)<before,'notebook_parent_cycle_or_missing'
trash=note('trash',root,'原回收站（保留）');attr(trash,'archived')
for row in M['notes']:note('source:'+row['id'],trash if row['is_deleted'] else L['notes']['book:'+row['notebook_id']],row['title'])
N={r['id']:L['notes']['source:'+r['id']] for r in M['notes']}
A={}
for row in M['attachments']:
 a=attachment('source:'+row['id'],N[row['note_id']],row['filename'],row['mime_type'] or 'application/octet-stream',(R/'export/attachments'/row['id']).read_bytes());A[row['id']]=a
meta=attachment('metadata',root,'OKnote-migration-metadata.json','application/json',(R/'export/metadata.json').read_bytes())
for row in M['notes']:
 old=row['id'];nid=N[old];raw=(R/'export/notes'/old).read_bytes()
 original=attachment('raw:'+old,nid,'OKnote-original.json' if row['type']=='mindmap' else 'OKnote-original.txt','application/json' if row['type']=='mindmap' else 'text/plain',raw)
 cv=Converter(N,A);body=cv.convert(raw,row['type']);assert_text_preserved(raw,body);assert not cv.unresolved
 body+='\n<hr><p><a href="api/attachments/'+original['id']+'/download">OK笔记原始正文（迁移留档）</a></p>'
 expected=sha(body.encode())
 if old not in L['finished']:
  api('/notes/'+nid+'/content','PUT',body.encode());received=api('/notes/'+nid+'/content',binary=True);assert sha(received)==expected
  attr(nid,'oknoteId',old)
  if row['starred']:attr(nid,'oknoteStarred')
  if row['pinned']:attr(nid,'oknotePinned')
  tags={x['id']:x for x in M['tags']}
  for link in M['note_tags']:
   if link['note_id']==old:
    tag=tags[link['tag_id']];label=tag.get('name') or tag.get('title');assert label
    attr(nid,'oknoteTag',label)
    attr(nid,'tag_'+re.sub(r'\s+','_',label))
  def dt(value):
   if isinstance(value,(int,float)):return datetime.datetime.fromtimestamp(value/(1000 if value>100000000000 else 1),datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]+'Z'
   return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]+'Z'
  api('/notes/'+nid,'PATCH',{'utcDateCreated':dt(row['created_at']),'utcDateModified':dt(row['updated_at'])})
  L['finished'][old]={'id':nid,'sha256':expected,'links':cv.links,'attachment_refs':sorted(cv.refs),'external_images':cv.external_images};progress('content')
 else:assert L['finished'][old]['sha256']==expected
if M['versions']:
 vr=note('history',root,'历史版本（迁移留档）');attr(vr,'archived')
 for row in M['versions']:
  old=row['id'];parent=N[row['note_id']];title=next(n['title'] for n in M['notes'] if n['id']==row['note_id'])
  vn=note('version:'+old,vr,title+' — '+str(row['created_at']));raw=(R/'export/versions'/old).read_bytes();a=attachment('version:'+old,vn,'OKnote-version-original.txt','text/plain',raw)
  cv=Converter(N,A);body='<p><a class="reference-link" href="#root/'+parent+'">当前版本</a></p>'+cv.convert(raw)+'<p><a href="api/attachments/'+a['id']+'/download">原始历史版本</a></p>'
  assert_text_preserved(raw,body)
  if old not in L['versions']:
   api('/notes/'+vn+'/content','PUT',body.encode());assert sha(api('/notes/'+vn+'/content',binary=True))==sha(body.encode())
   L['versions'][old]={'id':vn,'sha256':sha(body.encode())};progress('versions')
progress('import_complete')
print(json.dumps({'complete':True,'source_notes':len(L['finished']),'source_attachments':len(A),'total_attachments_including_archives':len(L['attachments']),'historical_versions':len(L['versions']),'tree_nodes':len(L['notes']),'root_note_id':root}))
