/** Loopback HTTP + real SQLite + real provider SSE parser. No .env or remote credentials. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,writeFileSync,readdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { SignJWT,decodeJwt } from 'jose';
import { LISTENING_WORKER_CAPABILITIES } from '../src/listening-http-contract.js';

test('real signing→main HTTP→lease→independent SSE content; real ordinary stores stay unchanged',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'listening-loopback-'));const originalCwd=process.cwd();process.chdir(dir);
 for(const key of ['CONFIG','DEVICES','ACCOUNTS','PROFILE','CONVERSATION','FEEDBACK','SMS','PAIRING','OTA','DIAGNOSTICS','TELEMETRY'])process.env[key+'_DB_PATH']=join(dir,key+'.db');
 Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-auth-listening-integration-32-bytes',LISTENING_GRANT_SECRET:'synthetic-grant-listening-integration-32-bytes',CUSTOM_LLM_API_KEY:'synthetic-worker-service',
  LIVEKIT_API_KEY:'synthetic-rtc-key',LIVEKIT_API_SECRET:'synthetic-rtc-secret-at-least-32bytes',LIVEKIT_URL:'wss://not-used.invalid',DEVICE_SESSION_RPM:'100',DEVICE_SN_ALLOW:'',
  LISTENING_WORKER_ACCOUNTS:JSON.stringify({'rust-worker':'worker-service'}),LISTENING_RELEASE_MANIFEST_PATH:join(dir,'release.json'),LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'synthetic-provider-key'});
 const sn='BJP00326070803800006',account='synthetic-listening-account',build='a'.repeat(40);const modelBodies:any[]=[];let upstreamCancelled=0;
 const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;modelBodies.push(JSON.parse(raw));
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'小熊分享了苹果，'}}]})+'\n\n');
  if(raw.includes('CANCEL_PENDING')){res.once('close',()=>{upstreamCancelled++;});return;}
  res.end('data: '+JSON.stringify({choices:[{delta:{content:'朋友很开心。'}}]})+'\n\ndata: [DONE]\n\n');
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${(provider.address() as any).port}/v1`;
 writeFileSync(process.env.LISTENING_RELEASE_MANIFEST_PATH!,JSON.stringify({version:1,expires_at_ms:Date.now()+600000,evidence_ref:'synthetic/loopback',agents:[{agent:'rust-worker',build_sha:build,capabilities:LISTENING_WORKER_CAPABILITIES}]}));
 let server:ReturnType<typeof serve>|undefined;
 try{
  const {deviceRegistryStore}=await import('../src/device-registry-store.js');deviceRegistryStore.add(sn,'synthetic');deviceRegistryStore.setAccountId(sn,account);
  const {getListeningSettingsStore}=await import('../src/listening-settings-store.js');const settings=getListeningSettingsStore();const cfg=settings.read().config;const {schema_version,revision,...editable}=cfg;
  settings.save(revision,{...editable,enabled:true,allowlist:[sn],tuning:{...editable.tuning,max_session_sec:300,feedback_max_chars:40,feedback_max_duration_sec:5,feedback_cooldown_sec:1,summary_interval_sec:60,summary_trigger_chars:1000,voice_invitation_enabled:false}},'synthetic-offline-fixture');
  const {getListeningAuthority,listeningWorkerAccounts,listeningRuntimeStatus}=await import('../src/listening-runtime.js');
  assert.equal(listeningRuntimeStatus().ready,false);
  assert.deepEqual(listeningWorkerAccounts('{"rust-worker":"worker-service","other":"worker-service"}'),{});
  const {deviceSessionRoute}=await import('../src/routes/device-session.js');const {createListeningRoute,createLazyListeningRoute}=await import('../src/routes/listening.js');
  const {generateListeningContent,readListeningPersonality}=await import('../src/listening-content.js');
  const {armFeedback,consumeFeedbackArmed}=await import('../src/feedback-arm.js');
  // Initialize ordinary DB schemas before comparing rows, never via ordinary chat.
  await Promise.all(['trait-store','relation-state-store','conversation-store','profile-store','feedback-store','growth-ledger-store','memory-item-store','extraction-log-store','child-insight-store'].map(p=>import('../src/'+p+'.js')));
  const app=new Hono().route('/v1/device',deviceSessionRoute).route('/v1/internal/listening',createLazyListeningRoute(()=>createListeningRoute(getListeningAuthority(),{generate:generateListeningContent,personality:readListeningPersonality})));
  server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const enc=new TextEncoder().encode(process.env.AUTH_JWT_SECRET);const sec=Math.floor(Date.now()/1000);
  const worker=await new SignJWT({role:'device',accountId:'worker-service'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt(sec-1).setExpirationTime(sec+600).sign(enc);
  const credential=await new SignJWT({kind:'p003-device'}).setProtectedHeader({alg:'HS256'}).setSubject(sn).setIssuedAt(sec-1).setExpirationTime(sec+600).sign(enc);
  const headers:any={authorization:'Bearer '+process.env.CUSTOM_LLM_API_KEY,'x-p003-worker-token':worker,'content-type':'application/json'};
  const call=(path:string,body:unknown,h=headers,signal?:AbortSignal)=>fetch(base+path,{method:'POST',headers:h,body:JSON.stringify(body),signal});
  const ready={version:1,request_id:'ready',agent:'rust-worker',instance_id:'loopback-worker',build_sha:build,registered:true,capabilities:LISTENING_WORKER_CAPABILITIES,applied_revision:null,applied_config_sha256:null};
  assert.equal((await fetch(base+'/v1/internal/listening/worker-ready',{method:'POST',headers,body:JSON.stringify(ready)+' '.repeat(4096)})).status,413);
  const offer=await(await call('/v1/internal/listening/worker-ready',ready)).json();assert.equal(offer.ready,false);
  assert.equal((await(await call('/v1/internal/listening/worker-ready',{...ready,applied_revision:offer.policy_revision,applied_config_sha256:offer.config_sha256})).json()).ready,true);
  const ticketResponse=await call('/v1/device/session',{device_sn:sn,trace_id:'loopback-trace',supports:['listening_mode_v1']},{authorization:'Bearer '+credential,'content-type':'application/json'});
  assert.equal(ticketResponse.status,200);const ticket=await ticketResponse.json();const rtc:any=decodeJwt(ticket.token);const metadata=JSON.parse(rtc.roomConfig.agents[0].metadata).listening;
  assert.ok(metadata,'eligible ticket must contain listening authority metadata');assert.ok(ticket.listening_contract);assert.equal(ticket.listening_contract.policy_revision,2);
  assert.equal(ticket.listening_contract.grant,undefined);assert.equal(metadata.session.session_id,ticket.session_id);assert.equal(metadata.session.room,ticket.room_name);assert.equal(metadata.session.account_id,account);
  headers['x-p003-listening-grant']=metadata.grant;
  const common={version:1,request_id:'offer',session:metadata.session,listening_id:'loopback-trace:1',scene:'story',mode_epoch:1};
  const leaseOffer=await(await call('/v1/internal/listening/lease',{...common,applied_snapshot_sha256:null})).json();assert.equal(leaseOffer.authorized,false);
  const lease=await(await call('/v1/internal/listening/lease',{...common,request_id:'apply',applied_snapshot_sha256:leaseOffer.snapshot.sha256})).json();assert.equal(lease.authorized,true);
  assert.equal(lease.snapshot.tuning.summary_trigger_chars,1000);assert.equal(lease.snapshot.tuning.summary_interval_sec,60);assert.equal(lease.snapshot.tuning.max_session_sec,300);
  const content={...common,snapshot_revision:lease.snapshot.revision,snapshot_sha256:lease.snapshot.sha256,has_gap:false};
  const snapshot=()=>{const result:any={};for(const file of readdirSync(dir).filter(f=>f.endsWith('.db')&&f!=='CONFIG.db'&&f!=='DEVICES.db')){const db=new DatabaseSync(join(dir,file));const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[];
   result[file]=Object.fromEntries(tables.map(t=>[t.name,db.prepare('SELECT * FROM "'+t.name.replaceAll('"','""')+'" ORDER BY rowid').all()]));db.close();}return result;};
  const {traitStore}=await import('../src/trait-store.js');traitStore.setTemplate(account,'quiet');
  const seeded=new DatabaseSync(process.env.PROFILE_DB_PATH!);seeded.prepare('INSERT INTO relation_state(account_id,first_seen_at,last_seen_at,current_session_started_at,updated_at) VALUES(?,?,?,?,?)').run(account,1,2,1,2);seeded.close();
  const before=snapshot();armFeedback(account);
  const summary={...content,request_id:'summary',base_summary_version:0,previous_summary:'',segments:[{seq:1,revision:1,text:'小熊分享苹果。'}]};
  assert.equal((await call('/v1/internal/listening/summary',summary)).status,200);
  const feedback={...content,request_id:'feedback',summary:'小熊分享苹果。',recent:'朋友笑了。',question:'你觉得呢？',trigger:'button'};
  const reply=await call('/v1/internal/listening/feedback',feedback);assert.equal(reply.status,200);const body=await reply.json();assert.equal(body.max_chars,40);assert.equal(body.max_duration_ms,5000);
  assert.deepEqual(snapshot(),before);assert.equal(consumeFeedbackArmed(account),true);assert.equal(modelBodies.length,2);
  assert.equal(modelBodies.every(b=>!b.tools&&b.messages.length===2&&b.thinking.type==='disabled'),true);
  assert.ok(!modelBodies[0].messages[0].content.includes('小可现有人格'));assert.ok(modelBodies[1].messages[0].content.includes('小可现有人格'));
  // Restarting HTTP router loses response RAM, but persisted RID remains spent.
  const restarted=new Hono().route('/v1/internal/listening',createListeningRoute(getListeningAuthority(),{generate:generateListeningContent,personality:readListeningPersonality}));
  const replay=await restarted.request('/v1/internal/listening/summary',{method:'POST',headers,body:JSON.stringify(summary)});assert.equal(replay.status,409);assert.equal(modelBodies.length,2);
  const cancelled=new AbortController();const pending=call('/v1/internal/listening/summary',{...summary,request_id:'cancel-summary',segments:[{seq:2,revision:1,text:'CANCEL_PENDING'}]},headers,cancelled.signal).catch(e=>e);
  for(let n=0;modelBodies.length<3&&n<200;n++)await new Promise(r=>setTimeout(r,5));assert.equal(modelBodies.length,3);cancelled.abort();assert.ok(await pending instanceof Error);
  for(let n=0;upstreamCancelled<1&&n<200;n++)await new Promise(r=>setTimeout(r,5));assert.equal(upstreamCancelled,1,'real HTTP disconnect aborts real provider stream');
  assert.equal(getListeningAuthority().store.request(metadata.session.session_id,'cancel-summary')?.status,'failed');assert.deepEqual(snapshot(),before);
  const db=new DatabaseSync(process.env.DEVICES_DB_PATH!);const persisted=JSON.stringify(db.prepare('SELECT * FROM listening_requests').all());db.close();
  assert.equal(persisted.includes('小熊'),false);assert.equal(persisted.includes(metadata.grant),false);
  const sourceRevision=settings.sourceGeneration();const {configStore}=await import('../src/config-store.js');
  configStore.setFlag('p003.search.canary.enabled','0','synthetic');configStore.setFlag('p003.search.canary.enabled','1','synthetic');assert.ok(settings.sourceGeneration()>sourceRevision);
  delete process.env.LISTENING_GRANT_SECRET;assert.equal(listeningRuntimeStatus().ready,false);
 }finally{if(server){if('closeAllConnections' in server)server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));process.chdir(originalCwd);rmSync(dir,{recursive:true,force:true});}
});
