import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
import {Hono} from 'hono';
import {SignJWT} from 'jose';
const root=mkdtempSync(join(tmpdir(),'ark-http-')),cwd=process.cwd();process.chdir(root);
for(const key of ['ACCOUNTS','DEVICES','PROFILE','CONFIG','CONVERSATION','FEEDBACK','ARK'])process.env[key+'_DB_PATH']=join(root,key.toLowerCase()+'.db');
const SN='BJP00399999999999901',SN2='BJP00399999999999902',SECRET='synthetic-only-secret',WORKER='synthetic-worker';
Object.assign(process.env,{AUTH_JWT_SECRET:SECRET,CUSTOM_LLM_API_KEY:'local-callback-test',ARK_CONTEXT_SN_ALLOW:SN,ARK_WORKER_ACCOUNT_ID:WORKER,LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'local-test',ANALYTICS_INTERNAL_SECRET:'internal-test',SEARCH_ENABLED:'0',SEARCH_CANARY_ROOT:'',MEMORY_EXTRACT_ENABLED:'1',COMPANION_KG_DIR:join(root,'absent'),CURRICULUM_KG_DIR:join(root,'absent')});
const {deviceRegistryStore:devices}=await import('../src/device-registry-store.js');
const {accountStore}=await import('../src/account-store.js');
const {profileStore}=await import('../src/profile-store.js');
const {arkService,arkStore}=await import('../src/ark/service.js');
const {arkRoute}=await import('../src/routes/ark.js');
const {customLlmRoute}=await import('../src/routes/custom-llm.js');
const {authRoute}=await import('../src/routes/auth.js');
const {AnalyticsStore}=await import('../src/analytics/store.js');
const {AnalyticsDeviceReader}=await import('../src/analytics/device-context.js');
const {createAnalyticsApp}=await import('../src/analytics/index.js');
const {extractAndPersist}=await import('../src/memory-extractor.js');
const {conversationStore}=await import('../src/conversation-store.js');
const scheduler=await import('../src/extract-scheduler.js');
const {memoryItemStore}=await import('../src/memory-item-store.js');
const {DatabaseSync}=await import('node:sqlite');
const servers:ReturnType<typeof serve>[]=[];
async function listen(app:Hono){const server=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'});servers.push(server);if(!server.listening)await once(server,'listening');return 'http://127.0.0.1:'+(server.address() as {port:number}).port;}
const captured:{stream:boolean;messages:{role:string;content:string}[]}[]=[];
const llm=new Hono();llm.post('/chat/completions',async c=>{const b=await c.req.json();captured.push(b);if(!b.stream)return c.json({choices:[{message:{content:JSON.stringify({interests:[{value:'画画',evidence:'我喜欢画画'}]})}}]});return c.text('data: '+JSON.stringify({choices:[{delta:{content:'端侧给出的剩余有效专注是3分钟。'},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',200,{'Content-Type':'text/event-stream'});});
process.env.DEEPSEEK_BASE_URL=await listen(llm);
const historyStore=new AnalyticsStore(join(root,'analytics.db'));
const reader=new AnalyticsDeviceReader({devicesPath:process.env.DEVICES_DB_PATH!,configPath:process.env.CONFIG_DB_PATH!,deviceKeySecret:'test-hmac-only',envAllow:[]});
const analytics=createAnalyticsApp({store:historyStore,reader,authSecret:SECRET,internalSecret:'internal-test',controlPath:join(root,'closed.json'),allowSubjects:[]});
let historyCalls=0;const historyApp=new Hono();historyApp.use('*',async(c,n)=>{historyCalls++;await n();});historyApp.route('/',analytics);
process.env.ARK_ANALYTICS_INTERNAL_URL=await listen(historyApp);
const app=new Hono();app.route('/ark',arkRoute);app.route('/v1',customLlmRoute);app.route('/auth',authRoute);const origin=await listen(app);
const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);assert.equal(url.hostname,'127.0.0.1','external calls forbidden');return nativeFetch(input,init);};
for(const sn of [SN,SN2]){devices.add(sn,'synthetic fixture');const a=accountStore.createDeviceAccount(sn,'fixture');devices.setAccountId(sn,a.id);profileStore.upsertProfile(a.id,{nickname:'测试',birthday:'2018-01',gender:'男孩'});}
const account=devices.arkIdentity(SN)!.account_id;
const jwt=async(sn=SN)=>new SignJWT({kind:'p003-device'}).setProtectedHeader({alg:'HS256'}).setSubject(sn).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(SECRET));
const workerJwt=await new SignJWT({accountId:WORKER,role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(SECRET));
const headers={Authorization:'Bearer '+await jwt(),'Content-Type':'application/json'};
const request=(path:string,body:unknown,extra:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:typeof body==='string'?body:JSON.stringify(body)});
const sample=()=>{const now=Date.now();return {schema_version:1,snapshot_id:'http-fixture',captured_at_ms:now,boot_id:'boot-http',boot_started_at_ms:now-60000,sequence:1,logical_day:new Date(now+8*3600000).toISOString().slice(0,10),config_revision:'fixture-rules',content_version:'fixture-content',source_mode:'normal',wallets:{family_coin:0,stardust:null},inventory:{'M-CARD-001':null},progress:{timer_state:'running',next_reward:{status:'locked',kind:'currency',item_id:'C-FAMILY-001',stage_id:'stage-fixture',remaining_seconds:121},claimable_count:0}};};
let admin='';
test('real HTTP: default closed, admin authorization and fixed scope ceiling',async()=>{
 assert.equal((await request('/ark/state',sample())).status,403);assert.equal((await fetch(origin+'/ark/admin/settings',{headers})).status,403);
 process.env.STUDIO_USER='test-admin';process.env.STUDIO_PASS='local-test';admin=(await (await request('/auth/login',{username:'test-admin',password:'local-test'})).json()).token;assert.ok(admin);
 process.env.STUDIO_EDITOR_USERS='fixture-editor';process.env.STUDIO_EDITOR_PASS='local-test';
 for(const username of ['fixture-editor','guest']){const token=(await (await request('/auth/login',{username,password:username==='guest'?'123456':'local-test'})).json()).token;assert.ok(token);for(const method of ['GET','PUT'])assert.equal((await fetch(origin+'/ark/admin/settings',{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='PUT'?{body:JSON.stringify({enabled:true,subjects:[SN]})}:{})})).status,403);}
 assert.equal((await (await fetch(origin+'/ark/admin/settings',{headers:{Authorization:'Bearer '+admin}})).json()).enabled,false);
 for(const [subjects,status]of [[[SN2],400],[[SN],200]]as const)assert.equal((await fetch(origin+'/ark/admin/settings',{method:'PUT',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,subjects,expected_revision:0})})).status,status);
});
test('real HTTP: Bearer isolation, byte limit, schema, duplicate timestamp, conflict, stale and rate limit',async()=>{
 assert.equal((await request('/ark/state',sample(),{Authorization:'Bearer invalid'})).status,401);assert.equal((await request('/ark/state',sample(),{Authorization:'Bearer '+await jwt(SN2)})).status,403);
 assert.equal((await request('/ark/state','x'.repeat(16385))).status,413);assert.equal((await request('/ark/state','{')).status,400);
 const s=sample();assert.equal((await request('/ark/state',{...s,sn:SN2})).status,400);
 const first=await (await request('/ark/state',s)).json(),dup=await (await request('/ark/state',s)).json();assert.equal(first.status,'accepted');assert.equal(dup.status,'duplicate');assert.equal(dup.received_at_ms,first.received_at_ms);
 assert.equal((await request('/ark/state',{...s,wallets:{family_coin:50,stardust:null}})).status,409);
 const newer={...s,sequence:2,snapshot_id:'second',captured_at_ms:Date.now()};assert.equal((await request('/ark/state',newer)).status,200);assert.equal((await request('/ark/state',s)).status,409);
 let status=0;for(let i=0;i<8&&status!==429;i++)status=(await request('/ark/state',newer)).status;assert.equal(status,429);
});
test('real internal HTTP: token, subject/account/epoch, malformed and oversized requests; upload remains shut',async()=>{
 const q={subject:SN,account_id:account,epoch:devices.arkIdentity(SN)!.epoch,not_before_ms:arkStore().grant(devices.arkIdentity(SN)!)!.not_before_ms};
 const post=(body:unknown,token='internal-test')=>fetch(process.env.ARK_ANALYTICS_INTERNAL_URL+'/internal/analytics/ark-summary',{method:'POST',headers:{'X-Analytics-Internal-Token':token,'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
 assert.equal((await post(q,'bad')).status,401);assert.equal((await post({...q,not_before_ms:1})).status,403);assert.equal((await post({...q,account_id:'other'})).status,403);assert.equal((await post({...q,epoch:q.epoch+1})).status,403);assert.equal((await post('{')).status,400);assert.equal((await post('x'.repeat(1025))).status,413);assert.equal((await (await post(q)).json()).status,'unknown');
 const health=await (await analytics.request('/ready')).json();assert.equal(health.gate_enabled,false);
});
const chat=async(text:string,history:{role:string;content:string}[]=[],token=workerJwt)=>{const response=await request('/v1/chat/completions?room=sn-'+SN+'-1793430000&token='+token,{messages:[...history,{role:'user',content:text}]},{Authorization:'Bearer local-callback-test'});assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/text\/event-stream/);assert.match(await response.text(),/\[DONE\]/);return captured.filter(x=>x.stream).at(-1)!;};
test('real custom-llm SSE: static/ordinary zero queries; prompt has authorized zero balance and source timestamps',async()=>{
 const before=historyCalls;await chat('你好');await chat('金币有什么用');assert.equal(historyCalls,before);
 const data=await chat('还有多久能领金币');assert.match(data.messages[0].content,/约3分钟/);assert.match(data.messages[0].content,/家族币余额：0/);assert.doesNotMatch(data.messages[0].content,/星尘余额：0/);
});
test('real SSE: stale history removed; followup requeries; admin preview same source; parent cannot query',async()=>{
 const before=historyCalls,data=await chat('那现在呢',[{role:'user',content:'金币还有多少'},{role:'assistant',content:'家族币余额是999999。'}]);assert.ok(historyCalls>before);assert.doesNotMatch(JSON.stringify(data.messages),/999999/);
 const p=await (await fetch(origin+'/ark/admin/preview?sn='+SN,{headers:{Authorization:'Bearer '+admin}})).json();assert.match(p.prompt,/约3分钟/);assert.equal(p.interface,'same_runtime_api_preview');
 const parent=await new SignJWT({accountId:'parent-test',role:'parent'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('10m').sign(new TextEncoder().encode(SECRET));const count=historyCalls,denied=await chat('金币还有多少',[],parent);assert.equal(historyCalls,count);assert.doesNotMatch(denied.messages[0].content,/【方舟事实·临时上下文】/);
 const saved=process.env.CUSTOM_LLM_API_KEY;delete process.env.CUSTOM_LLM_API_KEY;const prior=historyCalls;const unconfigured=await chat('金币还有多少');process.env.CUSTOM_LLM_API_KEY=saved;assert.equal(historyCalls,prior);assert.doesNotMatch(unconfigured.messages[0].content,/【方舟事实·临时上下文】/);
});
test('actual persistence: audit retained; current/later/idle windows skip dynamic extraction; ordinary interest still persists',async()=>{
 const db=new DatabaseSync(process.env.CONVERSATION_DB_PATH!,{readOnly:true});assert.ok((db.prepare('SELECT count(*) n FROM conversation WHERE account_id=?').get(account) as {n:number}).n>=2);db.close();
 const before=captured.filter(x=>!x.stream).length;
 for(const window of [[{role:'user' as const,content:'金币还有多少'},{role:'assistant' as const,content:'家族币余额是0。'}],[{role:'assistant' as const,content:'家族币余额是0，剩余有效专注3分钟'},{role:'user' as const,content:'那你讲个笑话'}]])await extractAndPersist(account,window,'rtc',{reason:'idle'});
 process.env.MEMORY_EXTRACT_MODE='trigger';scheduler.onTurn(account,'device','那你讲个笑话',1);assert.equal(await scheduler.flushIdle(Date.now()+scheduler.IDLE_MS+1),1);process.env.MEMORY_EXTRACT_MODE='turn';
 const other=devices.arkIdentity(SN2)!.account_id;conversationStore.add({account_id:other,session_id:'rtc',role:'assistant',text:'三枚呀',memory_excluded:true});process.env.MEMORY_EXTRACT_MODE='trigger';scheduler.onTurn(other,'device','现在呢',1);assert.equal(await scheduler.flushIdle(Date.now()+scheduler.IDLE_MS+1),1);process.env.MEMORY_EXTRACT_MODE='turn';
 const mixedCalls=captured.filter(x=>!x.stream).slice(before);for(const call of mixedCalls)assert.doesNotMatch(JSON.stringify(call.messages),/余额是0|有效专注3分钟|三枚呀/);assert.deepEqual(profileStore.getProfile(account)!.game_progress,[]);assert.equal(memoryItemStore.listByAccount(account).items.length,0);
 const cleanBefore=captured.filter(x=>!x.stream).length;await extractAndPersist(account,[{role:'user',content:'金币还有多少'},{role:'assistant',content:'家族币余额999999',memory_excluded:true},{role:'user',content:'我喜欢画画'},{role:'assistant',content:'画画很有趣'}],'rtc');assert.equal(captured.filter(x=>!x.stream).length,cleanBefore+1);assert.doesNotMatch(JSON.stringify(captured.at(-1).messages),/金币还有多少|999999/);assert.equal(profileStore.getProfile(account)!.interests[0]?.value,'画画');
});
test('disable/reactivation and credential revocation invalidate grants without restart',async()=>{
 devices.setStatus(SN,'disabled');assert.equal((await arkService().preview(SN)).prompt,'');devices.setStatus(SN,'active');assert.equal((await arkService().preview(SN)).prompt,'');arkStore().configure(true,[devices.arkIdentity(SN)!],Date.now());devices.revokeCredentials(SN,'test','test');assert.equal((await arkService().preview(SN)).prompt,'');assert.equal((await request('/ark/state',sample())).status,401);
});
after(async()=>{globalThis.fetch=nativeFetch;for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}historyStore.close();arkStore().close();process.chdir(cwd);rmSync(root,{recursive:true,force:true});});
