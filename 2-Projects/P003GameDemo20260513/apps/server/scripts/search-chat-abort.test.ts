import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SignJWT} from 'jose';
import {serve} from '@hono/node-server';
import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';

const dir=mkdtempSync(join(tmpdir(),'r22-chat-abort-'));
process.chdir(dir);
for(const name of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK','LOCAL_AUDIO','RELATION_STATE'])process.env[name+'_DB_PATH']=join(dir,name+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-secret',SEARCH_WORKER_ACCOUNT_ID:'worker',SEARCH_CANARY_ROOT:dir,SEARCH_TASK_DB_PATH:join(dir,'search.db'),DEEPSEEK_API_KEY:'synthetic',LLM_PROVIDER:'deepseek',MEMORY_EXTRACT_ENABLED:'0'});
const pending:{signal:AbortSignal;controller:ReadableStreamDefaultController<Uint8Array>;aborts:number}[]=[];
const encode=(text:string)=>new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n');
globalThis.fetch=(async(url,init)=>{
 assert.ok(String(url).endsWith('/chat/completions'));
 assert.equal(JSON.parse(String(init?.body)).messages.at(-1).content,'我们聊小猫');
 const signal=init?.signal as AbortSignal;
 return new Response(new ReadableStream<Uint8Array>({start(controller){
  const request={signal,controller,aborts:0};pending.push(request);
  signal.addEventListener('abort',()=>{request.aborts++;controller.error(new DOMException('Aborted','AbortError'));},{once:true});
  controller.enqueue(encode('我们聊小猫吧。'));
 }}),{headers:{'content-type':'text/event-stream'}});
}) as typeof fetch;
const {configStore}=await import('../src/config-store.js');
const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const {profileStore}=await import('../src/profile-store.js');
const {closeSearchRuntime}=await import('../src/tools/search-runtime.js');
const {customLlmRoute}=await import('../src/routes/custom-llm.js');
const sn='BJP00326060100100004',room=`sn-${sn}-1`;
deviceRegistryStore.add(sn,'test');deviceRegistryStore.setAccountId(sn,'device-A');
profileStore.upsertBasics('device-A',{nickname:'测试同学',birthday:'2019-01',gender:'男孩'});
configStore.setFlag('p003.search.allowlist',JSON.stringify([sn]),'test');configStore.setFlag('p003.search.enabled','1','test');configStore.setFlag('p003.search.canary.expires_at_ms',String(Date.now()+60000),'test');
const token=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('5m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
const call=()=>customLlmRoute.request(`/chat/completions?room=${room}&token=${token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'我们聊小猫'}]})});
const stored=()=>{const db=new DatabaseSync(process.env.CONVERSATION_DB_PATH!,{readOnly:true});try{return db.prepare('SELECT text FROM conversation').all().map(r=>r.text);}finally{db.close();}};
after(()=>closeSearchRuntime());

test('R22 cancelled candidate SSE aborts upstream once and does not persist an unfinished speculative reply',async()=>{
 const response=await call();const reader=response.body!.getReader();
 await reader.read();await reader.read();const request=pending.at(-1)!;
 await reader.cancel();await new Promise(r=>setImmediate(r));
 assert.equal(request.signal.aborted,true,'worker cancellation must reach model fetch');
 assert.equal(request.aborts,1);assert.deepEqual(stored(),[]);
});

test('R22 a completed candidate reply still streams and persists normally',async()=>{
 const response=await call();const reader=response.body!.getReader();let text='';
 const request=pending.at(-1)!;request.controller.close();
 while(true){const next=await reader.read();if(next.done)break;text+=new TextDecoder().decode(next.value);}
 assert.match(text,/我们聊小猫吧/);assert.match(text,/\[DONE\]/);
 assert.equal(request.signal.aborted,false);assert.deepEqual(stored(),['我们聊小猫','我们聊小猫吧。']);
});

test('R22 real Node HTTP disconnect propagates cancellation to the model',async()=>{
 const before=stored();
 const server=serve({fetch:customLlmRoute.fetch,port:0,hostname:'127.0.0.1'});
 try{
  if(!server.listening)await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const requestDone=new Promise<void>((resolve,reject)=>{
   const request=httpRequest({hostname:'127.0.0.1',port:address.port,path:`/chat/completions?room=${room}&token=${token}`,method:'POST',headers:{'content-type':'application/json'}},response=>{
    response.once('data',()=>{response.destroy();request.destroy();resolve();});
   });
   request.once('error',reject);
   request.end(JSON.stringify({messages:[{role:'user',content:'我们聊小猫'}]}));
  });
  await requestDone;
  const current=pending.at(-1)!;
  for(let n=0;n<50&&!current.signal.aborted;n++)await delay(10);
  assert.equal(current.signal.aborted,true);assert.equal(current.aborts,1);
  assert.deepEqual(stored(),before);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
