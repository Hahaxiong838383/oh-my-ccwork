const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const D=path.join(__dirname,'cache-publication-v2');
const manifest=JSON.parse(fs.readFileSync(path.join(D,'MANIFEST.json')));
const root=manifest.root;
const script=fs.readFileSync(path.join(root,'sw.js'),'utf8');
const handlers={},storage=new Map(),networkCalls=[];
const origin='http://codeg.test';
function key(v){return typeof v==='string'?new URL(v,origin).href:v.url}
const caches={keys:async()=>[...storage.keys()],delete:async n=>storage.delete(n),open:async n=>{
  if(!storage.has(n))storage.set(n,new Map());const entries=storage.get(n);
  return{match:async r=>entries.get(key(r))?.clone(),put:async(r,s)=>entries.set(key(r),s.clone())};
}};
function response(bytes,type='text/javascript'){const r=new Response(bytes,{headers:{'Content-Type':type}});Object.defineProperty(r,'type',{value:'basic'});return r}
const self={location:new URL(origin+'/sw.js?v=0.42.2'),addEventListener:(kind,fn)=>handlers[kind]=fn};
const fetch=async(req)=>{const url=typeof req==='string'?new URL(req,origin):new URL(req.url);networkCalls.push(url.pathname);const row=manifest.files.find(r=>'/'+r.relative===url.pathname);assert(row,'only prepared candidate fetched');return response(fs.readFileSync(path.join(D,row.candidate)));};
vm.runInNewContext(script,{self,caches,URL,fetch,Promise,Set,Error});
async function getAsset(name){const waits=[];let result;handlers.fetch({request:{url:origin+'/_next/static/chunks/'+name,method:'GET',mode:'cors'},respondWith:p=>result=p,waitUntil:p=>waits.push(p)});assert(result);const r=await result;const b=Buffer.from(await r.arrayBuffer());await Promise.all(waits);return b}
(async()=>{
  const cache=await caches.open('codeg-assets-v1-0.42.2');
  for(const[oldName,newName]of Object.entries(manifest.mapping)){
    const stale=fs.readFileSync(path.join(__dirname,oldName+'.before'));await cache.put('/_next/static/chunks/'+oldName,response(stale));
    const old=await getAsset(oldName);assert(old.equals(stale),'same URL retains stale cache');
    const before=networkCalls.length;const fresh=await getAsset(newName);assert(networkCalls.length===before+1,'new URL bypasses stale cache');
    const expected=manifest.files.find(r=>r.relative.endsWith('/'+newName));assert(crypto.createHash('sha256').update(fresh).digest('hex')===expected.after_sha256);
    assert(fresh.includes(Buffer.from('p003WorktreeDelegationVisible')));
    await getAsset(newName);assert(networkCalls.length===before+1,'new asset now cached without repeat network');
  }
  for(const row of manifest.files.filter(r=>r.backup)){
    const bytes=fs.readFileSync(path.join(D,row.candidate)).toString();for(const oldName of Object.keys(manifest.mapping))assert(!bytes.includes(oldName),'all affected route references versioned');
  }
  for(const url of ['/api/list_all_conversations','/ws/events']){let intercepted=false;handlers.fetch({request:{url:origin+url,method:'GET',mode:'cors'},respondWith:()=>intercepted=true});assert(!intercepted,'API/ws passthrough preserved')}
  const result={passed:true,stale_cache_reproduced:true,new_urls_fetch_fixed_bytes:true,new_urls_reuse_correct_cache:true,route_files_checked:8,api_ws_unchanged:true,sw_source_changed:false,visual_verified:false};
  fs.writeFileSync(path.join(D,'SW-CACHE-TEST.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.message);process.exitCode=1});
