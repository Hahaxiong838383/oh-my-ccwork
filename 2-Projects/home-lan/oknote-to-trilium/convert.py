"""Offline OKnote document conversion; never logs document values."""
import base64,html,json,re,urllib.parse,collections
from html.parser import HTMLParser
from markdown_it import MarkdownIt

def esc(x):return html.escape(str(x or ''),quote=True)
class Converter:
 def __init__(self,notes,attachments):
  self.notes=notes;self.attachments=attachments;self.refs=set();self.links=[];self.unresolved=[];self.external_images=0
 def url(self,s):
  s=str(s or '')
  m=re.search(r'(?:[?&]noteId=|^note:/*)([A-Za-z0-9_-]+)',s)
  if m:
   old=m[1]
   if old in self.notes:self.links.append(old);return '#root/'+self.notes[old]
   self.unresolved.append(old);return s
  if s.startswith('attachment:'):
   aid=s[11:];return self.asset(aid,False)
  if re.match(r'\s*(?:javascript|vbscript):',s,re.I):return ''
  return s
 def asset(self,aid,image):
  assert aid in self.attachments,'missing_attachment_reference'
  self.refs.add(aid);a=self.attachments[aid];return 'api/attachments/'+a['id']+('/image/'+urllib.parse.quote(a['name'],safe='') if image else '/download')
 def render(self,n):
  t=n['type'];a=n.get('attrs') or {};c=''.join(self.render(x) for x in n.get('content',[]))
  if t=='doc':return c
  if t=='text':
   s=esc(n.get('text',''))
   tags={'code':'code','bold':'strong','italic':'em','underline':'u','strike':'s','highlight':'mark','superscript':'sup','subscript':'sub'}
   for m in n.get('marks',[]):
    if m['type']=='link':s='<a href="'+esc(self.url((m.get('attrs') or {}).get('href')))+'">'+s+'</a>'
    else:
     assert m['type'] in tags,'unsupported_mark';tag=tags[m['type']];s='<'+tag+'>'+s+'</'+tag+'>'
   return s
  if t=='image':
   src=a.get('src','');aid=src[11:] if src.startswith('attachment:') else None
   if aid:src=self.asset(aid,True)
   else:self.external_images+=1;src=self.url(src)
   return '<figure class="image"><img src="'+esc(src)+'" alt="'+esc(a.get('alt',''))+'"></figure>'
  if t=='attachment':
   aid=a.get('id') or str(a.get('src',''))[11:]
   return '<p><a href="'+esc(self.asset(aid,False))+'">'+esc(a.get('name') or self.attachments[aid]['name'])+'</a></p>'
  if t in ['mathBlock','mathInline']:
   delim=('\\[','\\]') if t=='mathBlock' else ('\\(','\\)')
   return '<span class="math-tex">'+esc(delim[0]+a.get('latex','')+delim[1])+'</span>'
  if t=='hardBreak':return '<br>'
  if t=='horizontalRule':return '<hr>'
  if t=='heading':
   lv=int(a.get('level',1));assert 1<=lv<=6;return f'<h{lv}>'+c+f'</h{lv}>'
  if t=='codeBlock':return '<pre><code class="language-'+esc(a.get('language') or 'plaintext')+'">'+c+'</code></pre>'
  if t=='table':return '<figure class="table"><table><tbody>'+c+'</tbody></table></figure>'
  if t in ['tableCell','tableHeader']:
   tag='td' if t=='tableCell' else 'th';span=''.join(' '+k+'="'+str(int(a[k]))+'"' for k in ['colspan','rowspan'] if a.get(k));return '<'+tag+span+'>'+c+'</'+tag+'>'
  if t=='taskList':return '<ul class="todo-list">'+c+'</ul>'
  if t=='taskItem':
   # CKEditor task list markup, retaining checkbox state.
   checked=' checked="checked"' if a.get('checked') else ''
   if c.startswith('<p>'):c=c[3:];idx=c.find('</p>');first=c[:idx];rest=c[idx+4:]
   else:first=c;rest=''
   return '<li><label class="todo-list__label"><input type="checkbox" disabled="disabled"'+checked+'><span class="todo-list__label__description">'+first+'</span></label>'+rest+'</li>'
  tags={'paragraph':'p','bulletList':'ul','listItem':'li','orderedList':'ol','blockquote':'blockquote','tableRow':'tr'}
  assert t in tags,'unsupported_node'
  attr=''
  if t=='orderedList' and a.get('start'):attr=' start="'+str(int(a['start']))+'"'
  if t=='paragraph' and a.get('textAlign') in ['left','center','right','justify']:attr=' style="text-align:'+a['textAlign']+'"'
  tag=tags[t];return '<'+tag+attr+'>'+c+'</'+tag+'>'
 def convert(self,raw,kind='note'):
  text=raw.decode();m=re.match(r'\s*<!-- oknote:json:([^ ]+) -->',text)
  if m:return self.render(json.loads(base64.b64decode(m[1])))
  if kind=='mindmap':
   doc=json.loads(text)
   def branch(n):return '<li>'+esc(n.get('text',''))+('<ul>'+''.join(branch(x) for x in n['children'])+'</ul>' if n.get('children') else '')+'</li>'
   return '<p>思维导图已转为可编辑的大纲；原始导图 JSON 保存在本页附件中。</p><ul>'+branch(doc['root'])+'</ul>'
  md=MarkdownIt('commonmark',{'html':False}).enable('table').enable('strikethrough');h=md.render(text)
  return re.sub(r'(href|src)="([^"]*)"',lambda m:m[1]+'="'+esc(self.url(html.unescape(m[2])))+'"',h)

def source_text(raw):
 m=re.match(rb'\s*<!-- oknote:json:([^ ]+) -->',raw)
 if not m:return None
 doc=json.loads(base64.b64decode(m[1]));out=[]
 def walk(n):
  if n.get('type')=='text':out.append(n.get('text',''))
  for x in n.get('content',[]):walk(x)
 walk(doc);return out
class Texts(HTMLParser):
 def __init__(self):super().__init__();self.parts=[]
 def handle_data(self,s):self.parts.append(s)
def assert_text_preserved(raw,rendered):
 parts=source_text(raw)
 if parts is None:return
 p=Texts();p.feed(rendered);actual=''.join(p.parts);pos=0
 for part in parts:
  idx=actual.find(part,pos);assert idx>=0,'source_text_missing';pos=idx+len(part)
