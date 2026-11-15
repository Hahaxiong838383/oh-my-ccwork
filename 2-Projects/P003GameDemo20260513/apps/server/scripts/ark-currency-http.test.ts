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
let modelCalls=0,factsCalls=0;
process.env.DEEPSEEK_BASE_URL=await listen(new Hono().post('/chat/completions',async c=>{modelCalls++;const body=await c.req.json();const text=body.messages.at(-1).content;const protectedTexts=['请问','小可我现在有','文章捕','方舟里的补','这些收入怎么这样呢'];if(protectedTexts.includes(text)){assert.doesNotMatch(body.messages[0].content,/开灯=2/);if(text!=='这些收入怎么这样呢'){assert.ok(body.messages[0].content.length<500);assert.match(body.messages[0].content,/只用一句/);assert.match(body.messages[0].content,/小可读写台的游戏世界/);assert.equal(body.messages.length,2);}return c.text('data: '+JSON.stringify({choices:[{delta:{content:'[[DEV:'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{content:'90]]你继续说，我在听。'},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',200,{'Content-Type':'text/event-stream'});}if(text==='关灯')return c.text('data: '+JSON.stringify({choices:[{delta:{content:'[[DEV:3]]好的'},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',200,{'Content-Type':'text/event-stream'});return c.text('data: '+JSON.stringify({choices:[{delta:{content:'模型回退'},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',200,{'Content-Type':'text/event-stream'});}));
process.env.ARK_FACTS_PROXY_URL=await listen(new Hono().post('/internal/ark-facts',c=>{factsCalls++;return c.json({ok:false},403);}));
const {deviceRegistryStore:devices}=await import('../src/device-registry-store.js');const {accountStore}=await import('../src/account-store.js');const {profileStore}=await import('../src/profile-store.js');
devices.add(sn,'fixture');const a=accountStore.createDeviceAccount(sn,'fixture');devices.setAccountId(sn,a.id);profileStore.upsertProfile(a.id,{nickname:'测试',birthday:'2018-01',gender:'男孩'});
const {customLlmRoute}=await import('../src/routes/custom-llm.js');
const origin=await listen(new Hono().route('/v1',customLlmRoute));
async function token(role:string){return new SignJWT({accountId:worker,role}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('10m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));}
const deviceToken=await token('device'),parentToken=await token('parent');
async function chat(text:string,history:any[]=[],auth=deviceToken){const r=await fetch(origin+'/v1/chat/completions?room=sn-'+sn+'-123&token='+auth,{method:'POST',headers:{Authorization:'Bearer synthetic-key','Content-Type':'application/json'},body:JSON.stringify({messages:[...history,{role:'user',content:text}]})});assert.equal(r.status,200);const wire=await r.text();assert.match(wire,/\[DONE\]/);return wire.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)).choices[0].delta.content??'').join('');}
test('authenticated currency knowledge: real HTTP/SSE, empty dynamic allowlist, zero LLM and zero facts reads',async()=>{
 for(const q of ['金币','金币有什么用','这个金币是干嘛的呀','游戏道具怎么兑换','金币怎么买企鹅摆件','星尘有什么用','换一个游戏道具需要多少星尘','金币有什么用吗','金币还有什么用','下一枚金币有什么用']){
  assert.equal(await chat(q),answerArkResourceUse(q));assert.equal(modelCalls,0);assert.equal(factsCalls,0);
 }
 const history=[{role:'user',content:'金币有什么用'},{role:'assistant',content:'旧错误回答：金币可以买企鹅摆件'}];
 assert.equal(await chat('那能换什么',history),answerArkResourceUse('那能换什么',history));assert.equal(modelCalls,0);assert.equal(factsCalls,0);
 // Quantities/progress, other games, parent and anonymous traffic retain their existing model path.
 for(const q of ['我有多少金币','今天赚了多少金币','我的世界金币有什么用'])assert.equal(await chat(q),'模型回退');
 assert.equal(await chat('金币有什么用',[],parentToken),'模型回退');
 assert.equal(await chat('金币有什么用',[],''),'模型回退');
 assert.equal(modelCalls,5);
 for(const q of ['金币有什么用？今天天气怎么样','金币有什么用，讲个故事','讲个故事，金币有什么用','我不想听金币有什么用','「金币有什么用」是什么意思'])assert.equal(await chat(q),'模型回退');
 assert.equal(modelCalls,10);
});
test('unfinished speech cannot emit model DEV exit, while explicit device commands retain protocol',async()=>{for(const q of ['请问','小可我现在有','文章捕','方舟里的补','这些收入怎么这样呢'])assert.equal(await chat(q),'你继续说，我在听。');assert.equal(await chat('关灯'),'[[DEV:3]]好的');assert.equal(await chat('关灯',[{role:'user',content:'金币有什么用'}]),'[[DEV:3]]好的');});
test('time-linked claim failure queries facts instead of inventing a charging state',async()=>{
 process.env.ARK_DIRECT_REPLY_SN_ALLOW=sn;const before=modelCalls;
 try{const reply=await chat('分钟我领不了东西');assert.match(reply,/当前待领状态.*暂时查不到/);assert.doesNotMatch(reply,/看到你正在|夜航|合盖/);assert.equal(modelCalls,before);}finally{process.env.ARK_DIRECT_REPLY_SN_ALLOW='';}
});
test('family and half-word clarifications stay grounded without provider calls',async()=>{
 const before=modelCalls;
 for(const q of ['就是这个家族','方舟里的补','请问方舟里的补']){const reply=await chat(q);assert.equal(reply,answerArkResourceUse(q));assert.doesNotMatch(reply,/补给|补位|DEV:/);}
 assert.equal(modelCalls,before);
});
after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}process.chdir(cwd);rmSync(root,{recursive:true,force:true});});
