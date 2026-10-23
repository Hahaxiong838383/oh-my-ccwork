import pathlib,sys,json,collections,hashlib,re
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');sys.path[:0]=[str(R/'tools'),str(R/'tools/vendor')]
from convert import Converter,assert_text_preserved
meta=json.loads((R/'export/metadata.json').read_text());notes={r['id']:'okn'+hashlib.sha256(r['id'].encode()).hexdigest()[:24] for r in meta['notes']};atts={r['id']:{'id':'oka'+hashlib.sha256(r['id'].encode()).hexdigest()[:24],'name':r['filename']} for r in meta['attachments']}
counts=collections.Counter();allrefs=set();unresolved=set();schemes=collections.Counter()
for row in meta['notes']:
 raw=(R/'export/notes'/row['id']).read_bytes();cv=Converter(notes,atts);h=cv.convert(raw,row['type']);assert_text_preserved(raw,h)
 counts['notes_converted']+=1;counts['internal_links']+=len(cv.links);counts['external_images']+=cv.external_images;allrefs|=cv.refs;unresolved.update(cv.unresolved)
counts['unique_referenced_attachments']=len(allrefs);counts['dangling_source_note_ids']=len(unresolved)
counts['source_orphan_attachments']=sum(r['note_id'] not in notes for r in meta['attachments'])
(R/'conversion-preflight.json').write_text(json.dumps(dict(counts)));print(json.dumps(dict(counts)))
