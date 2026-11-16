from pathlib import Path
import json,hashlib
D=Path(__file__).parent
helper='function p003WorktreeDelegationVisible(child,folders,rows){return child.kind==="delegate"&&folders.some(folder=>folder.id===child.folder_id&&folder.parent_id!=null)&&rows.some(parent=>parent.id===child.parent_id&&parent.folder_id!==child.folder_id)}'
manifest=json.loads((D/'manifest-before.json').read_text())
for x in manifest:
 s=(D/(x['name']+'.before')).read_text();assert hashlib.sha256(s.encode()).hexdigest()==x['before_sha256']
 agg,tombs,store=('a','u','m')if x['name'].startswith('048')else('l','d','b')
 old=f'let t=await (0,n.listAllConversations)();e({{...{agg}(t),conversationsError:null}})'
 new=f'let [p003Rows,p003Folders]=await Promise.all([(0,n.listAllConversations)({{include_children:!0}}),(0,n.listAllFolderDetails)()]);let p003Visible=p003Rows.filter(row=>null==row.parent_id||p003WorktreeDelegationVisible(row,p003Folders,p003Rows));e({{...{agg}(p003Visible),conversationsError:null}})'
 needle=f'let {store}=(0,t.f)()';assert s.count(needle)==1;s=s.replace(needle,helper+needle)
 assert s.count(old)==1;s=s.replace(old,new)
 old=f'if(null!=r.parent_id||{tombs}.has(r.id))return;'
 new=f'if(null!=r.parent_id&&!p003WorktreeDelegationVisible(r,t().allFolders,t().conversations)||{tombs}.has(r.id))return;'
 assert s.count(old)==1;s=s.replace(old,new);p=D/(x['name']+'.after.js');p.write_text(s);x['after_sha256']=hashlib.sha256(p.read_bytes()).hexdigest()
(D/'manifest.json').write_text(json.dumps(manifest,indent=2))
