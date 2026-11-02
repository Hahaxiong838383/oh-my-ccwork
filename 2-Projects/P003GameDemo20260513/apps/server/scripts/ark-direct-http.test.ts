import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';
import {serve} from '@hono/node-server';import {Hono} from 'hono';import {SignJWT} from 'jose';
const root=mkdtempSync(join(tmpdir(),'ark-direct-')),cwd=process.cwd();process.chdir(root);
for(const key of ['ACCOUNTS','DEVICES','PROFILE','CONFIG','CONVERSATION','FEEDBACK','ARK','MEMORY_ITEMS'])process.env[key+'_DB_PATH']=join(root,key.toLowerCase()+'.db');
const sn='BJP00399999999999901',worker='synthetic-proxy-worker';
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-auth',CUSTOM_LLM_API_KEY:'synthetic-key',SEARCH_WORKER_ACCOUNT_ID:worker,ARK_DIRECT_REPLY_SN_ALLOW:sn,SEARCH_CANARY_SN:sn,SEARCH_CANARY_ROOT:'',SEARCH_ENABLED:'0',ARK_FACTS_PROXY_SECRET:'s'.repeat(40),LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'synthetic',MEMORY_EXTRACT_ENABLED:'0',COMPANION_KG_DIR:join(root,'absent'),CURRICULUM_KG_DIR:join(root,'absent')});
const servers:ReturnType<typeof serve>[]=[];async function listen(app:Hono){const s=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'});servers.push(s);if(!s.listening)await once(s,'listening');return 'http://127.0.0.1:'+(s.address() as any).port;}
let modelCalls=0,factsCalls=0,mode='normal';const provider=new Hono().post('/chat/completions',async c=>{modelCalls++;return c.text('data: '+JSON.stringify({choices:[{delta:{content:'普通回答'},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',200,{'Content-Type':'text/event-stream'});});
process.env.DEEPSEEK_BASE_URL=await listen(provider);
const facts=new Hono().post('/internal/ark-facts',async c=>{factsCalls++;assert.deepEqual(await c.req.json(),{subject:sn});assert.equal(c.req.header('X-Ark-Internal-Token'),'s'.repeat(40));const now=Date.now();const fact={value:0,occurred_at_ms:now,received_at_ms:now,content_version:null};const dto={schema_version:1,subject:mode==='wrong-sn'?sn.slice(0,-1)+'2':sn,assets:{family_coin:mode==='gm'?null:fact,stardust:null,makeup_card:null},progress:null};return c.json(mode==='legacy'?{ok:true,prompt:'家族币余额999999'}:{ok:true,prompt:'测试事实',facts_v1:dto});});
process.env.ARK_FACTS_PROXY_URL=await listen(facts);
const {deviceRegistryStore:devices}=await import('../src/device-registry-store.js');const {accountStore}=await import('../src/account-store.js');const {profileStore}=await import('../src/profile-store.js');
devices.add(sn,'fixture');const a=accountStore.createDeviceAccount(sn,'fixture');devices.setAccountId(sn,a.id);profileStore.upsertProfile(a.id,{nickname:'测试',birthday:'2018-01',gender:'男孩'});
const {customLlmRoute}=await import('../src/routes/custom-llm.js');const {conversationStore}=await import('../src/conversation-store.js');
const origin=await listen(new Hono().route('/v1',customLlmRoute));
const token=await new SignJWT({accountId:worker,role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('10m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
async function chat(text:string,history:any[]=[],room='sn-'+sn+'-123'){const r=await fetch(origin+'/v1/chat/completions?room='+room+'&token='+token,{method:'POST',headers:{Authorization:'Bearer synthetic-key','Content-Type':'application/json'},body:JSON.stringify({messages:[...history,{role:'user',content:text}]})});assert.equal(r.status,200);const wire=await r.text();assert.match(wire,/\[DONE\]/);return wire.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)).choices[0].delta.content??'').join('');}
test('actual SSE direct route returns authority facts, no model suffix, safe legacy/GM/identity fallback',async()=>{
 assert.match(await chat('我有几枚家族币'),/家族币余额是0枚/);assert.equal(modelCalls,0);assert.equal(factsCalls,1);
 assert.match(await chat('那现在呢',[{role:'user',content:'我有几枚家族币'},{role:'assistant',content:'999999枚'}]),/家族币余额是0枚/);assert.equal(modelCalls,0);
 for(mode of ['gm','wrong-sn','legacy']){assert.match(await chat('家族币还有多少'),/暂时查不到/);assert.equal(modelCalls,0);}
 assert.match(await chat('今天方舟收益怎么样'),/不能把钱包余额/);assert.match(await chat('星辰有什么用'),/换装/);assert.match(await chat('金币有什么用'),/家族币，还是星尘/);assert.equal(modelCalls,0);
 const callsBefore=factsCalls;assert.equal(await chat('那现在原神金币还有多少',[{role:'user',content:'家族币还有多少'},{role:'assistant',content:'0枚'}]),'普通回答');assert.equal(factsCalls,callsBefore);modelCalls--;
 assert.equal(await chat('天上的星辰是什么'),'普通回答');assert.equal(modelCalls,1);
 assert.equal(await chat('家族币还有多少',[],'sn-BJP00399999999999902-123'),'普通回答');assert.equal(modelCalls,2);
 const rows=conversationStore.list({account_id:a.id,limit:100});assert.ok(rows.some(r=>r.text.includes('家族币余额是0枚')&&r.memory_excluded));
 assert.equal(existsSync(process.env.ARK_DB_PATH!),false,'proxy does not open writable Ark DB');
});
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}process.chdir(cwd);rmSync(root,{recursive:true,force:true});});
