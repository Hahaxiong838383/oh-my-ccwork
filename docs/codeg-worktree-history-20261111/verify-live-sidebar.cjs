const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const base = `http://127.0.0.1:${process.env.CODEG_PORT}`;
const evidenceDir = process.env.CODEG_VISIBILITY_EVIDENCE_DIR || __dirname;
const backupDir = process.env.CODEG_VISIBILITY_BACKUP_DIR || __dirname;
const output = path.join(evidenceDir, 'LIVE-SIDEBAR-HTTP.json');
const registrations = [];
const context = {globalThis:{TURBOPACK:registrations}, console, Map, Set, Promise, Date};
const modules = new Map();
const wire = [];
const transport = {getTransport:()=>({call:async(command,args)=>{
  assert(['list_all_conversations','list_all_folder_details','list_open_folder_details','list_folder_groups'].includes(command), 'read-only commands');
  const response = await fetch(`${base}/api/${command}`,{method:'POST',headers:{Authorization:`Bearer ${process.env.CODEG_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(args??{})});
  assert(response.ok, `${command} HTTP ${response.status}`);
  wire.push({command,args});return response.json();
}})};
const create = ()=>initializer=>{let state;const get=()=>state;const set=patch=>{state=Object.assign({},state,typeof patch==='function'?patch(state):patch)};state=initializer(set,get);return{getState:get,setState:set}};
function findFactory(id){for(const reg of registrations){let ids=[];for(const entry of reg.slice(1)){if(typeof entry==='number')ids.push(entry);else if(typeof entry==='function'){if(ids.includes(id))return entry;ids=[];}}}throw Error(`module ${id} missing`)}
function execute(factory){factory({i:id=>id===941036?transport:id===46691?{f:create}:id===297899?{d:()=>{}}:id===99911?{_:String}:modules.get(id)??{},s:(entries,id)=>{const exports=modules.get(id)??{};for(let i=0;i<entries.length;i+=3)exports[entries[i]]=entries[i+2];modules.set(id,exports);}});}
function namedFunction(source,name){const start=source.indexOf(`function ${name}(`);assert(start>=0);const end=source.indexOf('function ',start+9);assert(end>start);return source.slice(start,end);}
(async()=>{
  const html=await(await fetch(`${base}/workspace`)).text();
  const scriptNames=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m=>m[1]);
  const required=['0mikm5622wrri.js','048tzznh3mzxz.js','3r8av1xqxfxav.js'];
  const assets={};
  for(const name of required){const url=scriptNames.find(x=>x.endsWith('/'+name));assert(url, `workspace references ${name}`);const r=await fetch(base+url);assert(r.ok);assets[name]=await r.text();}
  vm.runInNewContext(assets['0mikm5622wrri.js'],context);
  execute(findFactory(209165));
  const api=modules.get(209165);assert(api?.listAllConversations);
  const source=assets['3r8av1xqxfxav.js'];
  const marker='function(e){let{pinned:t,pinnedExpanded:n,orderedFolderIds:r,byFolder:a,';
  const start=source.indexOf(marker), end=source.indexOf('})({pinned:tU',start);
  assert(start>=0&&end>start);
  const flattenSource=source.slice(start,end+1);
  const sandbox={Map,Set,aJ:['folders','chats','recent']};
  const flatten=vm.runInNewContext(`${namedFunction(source,'a1')};${namedFunction(source,'sh')};(${flattenSource})`,sandbox);
  const verdicts=[];
  for(const mode of ['before','deployed']){
    const storeSource=mode==='before'?fs.readFileSync(path.join(backupDir,'048tzznh3mzxz.js.before'),'utf8'):assets['048tzznh3mzxz.js'];
    registrations.length=0;vm.runInNewContext(storeSource,context);modules.delete(137937);modules.delete(975294);execute(findFactory(137937));
    const store=modules.get(137937).n;
    await Promise.all([store.getState().fetchFolders(),store.getState().refreshConversations()]);
    assert(!store.getState().conversationsError);
    const state=store.getState();
    // Exact sidebar folder grouping and row-flattening body from deployed component.
    const groupStart=source.indexOf('function(e,t,n,r){let a=new Map;for(let t of e){let e=r?.get(t.folder_id)');
    const groupEnd=source.indexOf('}(tB,n,tQ.current,tJ)',groupStart);
    assert(groupStart>=0&&groupEnd>groupStart);
    const group=vm.runInNewContext(`(${source.slice(groupStart,groupEnd+1)})`,{Map,a6:()=>0,a8:()=>0,st:()=>false});
    const conv=state.conversations.filter(e=>e.pinned_at==null&&e.kind!=='chat');
    const byFolder=group(conv,'created',new Map(),new Map());
    const counts=new Map([...byFolder].map(([id,rows])=>[id,rows.length]));
    const rows=flatten({pinned:[],pinnedExpanded:true,orderedFolderIds:[38,44,50,53],byFolder,folderExpanded:{},folderTotalCounts:counts,foldersExpanded:true,chatConversations:[],chatsExpanded:false,recentConversations:[],recentExpanded:false,showRecent:false,sectionOrder:['folders'],conversationExpanded:new Set(),childrenByParent:new Map(),childrenLoading:new Set(),containerChildren:new Map(),rootGroupCollapsed:new Set(),groupExpanded:{},hideEmptyFolders:false});
    const shown=rows.filter(x=>x.kind==='conversation').map(x=>x.conversation.id);
    const empty=rows.filter(x=>x.kind==='empty').map(x=>x.folderId);
    if(mode==='before'){assert(!shown.includes(251)&&!shown.includes(191));assert(empty.includes(44)&&empty.includes(53));}
    else{assert(shown.includes(251)&&shown.includes(191)&&shown.includes(253)&&shown.includes(254));assert(!empty.length);}
    verdicts.push({mode,shown_sessions:shown,empty_folders:empty,store_conversation_count:state.conversations.length});
  }
  const result={status:'PASS_HTTP_WRAPPER_STORE_SIDEBAR_ROWS_NOT_BROWSER',verdicts,wire,assets:Object.fromEntries(Object.entries(assets).map(([n,s])=>[n,crypto.createHash('sha256').update(s).digest('hex')])),visual_verified:false};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
