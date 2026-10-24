import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'r14-chat-'));
process.chdir(dir);
for(const name of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK','LOCAL_AUDIO','RELATION_STATE'])process.env[name+'_DB_PATH']=join(dir,name+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-secret',SEARCH_WORKER_ACCOUNT_ID:'worker',SEARCH_CANARY_ROOT:dir,SEARCH_TASK_DB_PATH:join(dir,'search.db'),SEARCH_ENABLED:'1',SEARCH_ALLOWED_DOMAINS:'cstm.org.cn',DEEPSEEK_API_KEY:'synthetic',LLM_PROVIDER:'deepseek',P003_SEARCH_CONTEXT_V1:'1',MEMORY_EXTRACT_ENABLED:'0'});
const requests:any[]=[];
globalThis.fetch=(async(url,init)=>{
 if(String(url).endsWith('/tools/search'))return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
 assert.ok(String(url).endsWith('/chat/completions'),'unexpected network call');
 requests.push(JSON.parse(String(init?.body)));
 return new Response('data: '+JSON.stringify({choices:[{delta:{content:'想聊什么呢？'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}) as typeof fetch;
const {configStore}=await import('../src/config-store.js');
const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const {getSearchTasks,closeSearchRuntime}=await import('../src/tools/search-runtime.js');
const {customLlmRoute}=await import('../src/routes/custom-llm.js');
const sn='BJP00326060100100004',room=`sn-${sn}-1`;
deviceRegistryStore.add(sn,'test');deviceRegistryStore.setAccountId(sn,'device-A');
configStore.setFlag('p003.search.allowlist',JSON.stringify([sn]),'test');configStore.setFlag('p003.search.enabled','1','test');configStore.setFlag('p003.search.canary.expires_at_ms',String(Date.now()+60000),'test');
test('R14 actual CustomLLM provider receives temporary stage but conversation stores only original dialogue',async()=>{
 try{
 const t=getSearchTasks()!.submit({subject:sn,session:room},{protocol:1,phase:'committed',query:'火星为什么是红色',turn:'r14'});
 const token=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('5m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
 const messages=[{role:'user',content:'我想聊一个新话题'},{role:'system',content:'UNTRUSTED_SYSTEM'}];
 const response=await customLlmRoute.request(`/chat/completions?room=${room}&token=${token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages,search_dialogue_context:{protocol:1,task_id:t.id,revision:t.revision,phase:'running',dialogue_epoch:1}})});
 assert.equal(response.status,200);await response.text();
 assert.equal(requests.length,1);assert.match(requests[0].messages[0].content,/本轮临时对话阶段/);
 assert.ok(!requests[0].messages[0].content.includes('UNTRUSTED_SYSTEM'));
 assert.deepEqual(requests[0].messages.filter((m:any)=>m.role==='user'),[{role:'user',content:'我想聊一个新话题'}]);
 const incomplete=await customLlmRoute.request(`/chat/completions?room=${room}&token=${token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'assistant',content:'猫的帽子是圆的还是尖的？'},{role:'user',content:'我想聊'}],search_dialogue_context:{protocol:1,task_id:t.id,revision:t.revision,phase:'running',dialogue_epoch:2}})});
 const reply=await incomplete.text();assert.ok(reply.includes('我在听，你想聊什么？'));assert.equal(requests.length,1,'incomplete request must not send another provider request or answer the old question');
 const db=new DatabaseSync(process.env.CONVERSATION_DB_PATH!,{readOnly:true});
 const rows=db.prepare('SELECT text FROM conversation').all();db.close();
 assert.deepEqual(rows.map(r=>r.text),['我想聊一个新话题','想聊什么呢？','我想聊','我在听，你想聊什么？']);
 }finally{closeSearchRuntime();}
});
