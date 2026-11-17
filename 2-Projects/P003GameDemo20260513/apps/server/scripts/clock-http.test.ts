import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';
import {serve} from '@hono/node-server';import {Hono} from 'hono';import {SignJWT} from 'jose';
import {answerArkResourceUse} from '../src/xiaoke-kb.js';
const root=mkdtempSync(join(tmpdir(),'ark-currency-http-')),cwd=process.cwd();process.chdir(root);
for(const key of ['ACCOUNTS','DEVICES','PROFILE','CONFIG','CONVERSATION','FEEDBACK','ARK','MEMORY_ITEMS'])process.env[key+'_DB_PATH']=join(root,key.toLowerCase()+'.db');
const sn='BJP00399999999999901',worker='synthetic-currency-worker';
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-auth',CUSTOM_LLM_API_KEY:'synthetic-key',SEARCH_WORKER_ACCOUNT_ID:worker,ARK_DIRECT_REPLY_SN_ALLOW:'',SEARCH_CANARY_SN:sn,SEARCH_CANARY_ROOT:'',SEARCH_ENABLED:'0',ARK_FACTS_PROXY_SECRET:'s'.repeat(40),DEVICE_INTENT_OBSERVE:'1',LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'synthetic',MEMORY_EXTRACT_ENABLED:'0',COMPANION_KG_DIR:join(root,'absent'),CURRICULUM_KG_DIR:join(root,'absent')});
const servers:ReturnType<typeof serve>[]=[];async function listen(app:Hono){const s=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'});servers.push(s);if(!s.listening)await once(s,'listening');return 'http://127.0.0.1:'+(s.address() as any).port;}
let modelCalls=0,factsCalls=0,lastModelBody:any;
process.env.DEEPSEEK_BASE_URL=await listen(new Hono().post('/chat/completions',async c=>{modelCalls++;const body=await c.req.json();lastModelBody=body;const text=body.messages.at(-1).content;const protectedTexts=['请问','小可我现在有','文章捕','方舟里的补','这些收入怎么这样呢'];if(protectedTexts.includes(text)){assert.doesNotMatch(body.messages[0].content,/开灯=2/);if(text!=='这些收入怎么这样呢'){assert.ok(body.messages[0].content.length<500);assert.match(body.messages[0].content,/只用一句/);assert.match(body.messages[0].content,/小可读写台的游戏世界/);assert.equal(body.messages.length,2);}return c.text('data: '+JSON.stringify({choices:[{delta:{content:'[[DEV:'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{content:'90]]你继续说，我在听。'},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',200,{'Content-Type':'text/event-stream'});}if(text==='关灯')return c.text('data: '+JSON.stringify({choices:[{delta:{content:'[[DEV:3]]好的'},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',200,{'Content-Type':'text/event-stream'});return c.text('data: '+JSON.stringify({choices:[{delta:{content:'模型回退'},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',200,{'Content-Type':'text/event-stream'});}));
process.env.ARK_FACTS_PROXY_URL=await listen(new Hono().post('/internal/ark-facts',c=>{factsCalls++;return c.json({ok:false},403);}));
const {deviceRegistryStore:devices}=await import('../src/device-registry-store.js');const {accountStore}=await import('../src/account-store.js');const {profileStore}=await import('../src/profile-store.js');
devices.add(sn,'fixture');const a=accountStore.createDeviceAccount(sn,'fixture');devices.setAccountId(sn,a.id);profileStore.upsertProfile(a.id,{nickname:'测试',birthday:'2018-01',gender:'男孩'});
const {customLlmRoute}=await import('../src/routes/custom-llm.js');
const origin=await listen(new Hono().route('/v1',customLlmRoute));
async function token(role:string){return new SignJWT({accountId:worker,role}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('10m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));}
const deviceToken=await token('device'),parentToken=await token('parent');
async function chat(text:string,history:any[]=[],auth=deviceToken){const r=await fetch(origin+'/v1/chat/completions?room=sn-'+sn+'-123&token='+auth,{method:'POST',headers:{Authorization:'Bearer synthetic-key','Content-Type':'application/json'},body:JSON.stringify({messages:[...history,{role:'user',content:text}]})});assert.equal(r.status,200);const wire=await r.text();assert.match(wire,/\[DONE\]/);return wire.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)).choices[0].delta.content??'').join('');}
test('clock uses authenticated real HTTP SSE with zero upstream or Ark requests',async()=>{
 const before=modelCalls;
 for(const q of ['现在几点了','今天是周几','今天几号','上海现在几点','纽约现在几点','帮我查现在几点']){
  const reply=await chat(q);assert.match(reply,/现在是|今天是/);assert.doesNotMatch(reply,/模型回退|查不到|不知道/);
 }
 assert.equal(modelCalls,before);assert.equal(factsCalls,0);
 assert.match(await chat('美国时间'),/好几个时区/);
 assert.match(await chat('纽约',[{role:'user',content:'美国时间'},{role:'assistant',content:'美国有好几个时区，你想问哪个城市？'}]),/纽约现在是/);
 assert.equal(modelCalls,before);
});
test('later ordinary prompt excludes stale clock answers from memory input',async()=>{
 await chat('我喜欢熊猫',[{role:'user',content:'现在几点了'},{role:'assistant',content:'现在是北京时间早上七点三十八分。'}]);
 assert.doesNotMatch(JSON.stringify(lastModelBody.messages),/七点三十八分|现在几点了/);
});
test('clock preserves disabled flag, anonymous/parent and non-clock model behavior',async()=>{
 assert.equal(await chat('现在几点了',[],parentToken),'模型回退');assert.equal(await chat('现在几点了',[],''),'模型回退');
 process.env.P003_CLOCK_ENABLED='0';try{assert.equal(await chat('现在几点了'),'模型回退');}finally{delete process.env.P003_CLOCK_ENABLED;}
 for(const q of ['现在几点开门','今天下午几点开会','明天提醒我起床','我使用了多久','纽约有什么好玩的'])assert.equal(await chat(q),'模型回退');
});
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}process.chdir(cwd);rmSync(root,{recursive:true,force:true});});
