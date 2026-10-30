import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { testAuthority } from './lib/listening-test.js';
const code=(c:string)=>(error:any)=>error.code===c;
test('manifest plus authenticated configuration application evidence is needed for readiness',async()=>{const f=await testAuthority();try{
 assert.equal(f.authority.runtime().ready,true);
 f.manifest.agents=[];assert.equal(f.authority.runtime().ready,false);
 await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null}),code('worker_not_ready'));
}finally{f.cleanup();}});
test('grant stored with real identity; offer cannot authorize until snapshot applied; lease capped at15sec',async()=>{const f=await testAuthority();try{
 assert.equal(f.metadata.authority,'p003-main-brain');assert.equal(f.store.session('test-session-1')?.account_id,'test-account-1');
 const first=await f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null});assert.equal(first.authorized,false);assert.equal(first.lease_expires_at_ms,0);
 const request={...f.base,request_id:'lease-2',applied_snapshot_sha256:first.snapshot.sha256};const lease=await f.authority.lease(f.headers,request);
 assert.equal(lease.authorized,true);assert.equal(lease.lease_expires_at_ms,f.now()+15000);assert.equal(lease.policy_revision,2);
 f.advance(1000);assert.equal((await f.authority.lease(f.headers,request)).lease_expires_at_ms,lease.lease_expires_at_ms);
 assert.equal(f.authority.runtime().active_sessions,1);
}finally{f.cleanup();}});
test('missing/wrong worker, service, grant, parent role and cross-session spoofing all fail closed',async()=>{const f=await testAuthority();try{
 const body={...f.base,applied_snapshot_sha256:null};
 for(const key of ['authorization','x-p003-worker-token','x-p003-listening-grant']){const h:any={...f.headers};delete h[key];await assert.rejects(()=>f.authority.lease(h,body));}
 const parent=await new SignJWT({role:'parent',accountId:'worker-service'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt(f.now()/1000).setExpirationTime(f.now()/1000+300).sign(new TextEncoder().encode(f.secrets.authSecret));
 await assert.rejects(()=>f.authority.lease({...f.headers,'x-p003-worker-token':parent},body));
 for(const [key,value] of Object.entries({account_id:'other',room:f.base.session.room+'1',trace_id:'other-trace',sn:'BJP00326070803800007',session_id:'another-session'}))
  await assert.rejects(()=>f.authority.lease(f.headers,{...body,session:{...body.session,[key]:value}}));
 f.secrets.serviceKey='';await assert.rejects(()=>f.authority.lease(f.headers,body),code('authority_unavailable'));
}finally{f.cleanup();}});
test('account A→B→A, credential revocation at same second, disabled source and expiry revoke',async()=>{for(const reason of ['rebind','credential','source','expiry']){const f=await testAuthority();try{
 if(reason==='rebind'){f.db.prepare('UPDATE device_registry SET account_id=? WHERE sn=?').run('other',f.sn);f.db.prepare('UPDATE device_registry SET account_id=? WHERE sn=?').run('test-account-1',f.sn);}
 if(reason==='credential')f.db.prepare('INSERT INTO device_credential_revocation VALUES(?,?)').run(f.sn,f.now()/1000-1);
 if(reason==='source')f.setSourceUntil(f.now());if(reason==='expiry')f.advance(1800000);
 await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null}),reason);
}finally{f.cleanup();}}});
test('config revision is latest but entry tuning stays frozen; close works after gate disabled',async()=>{const f=await testAuthority();try{
 const offered=await f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null});const cfg=f.settings.read().config;const {schema_version,revision,...edit}=cfg;
 f.settings.save(revision,{...edit,tuning:{...edit.tuning,feedback_max_chars:120}},'test-admin');
 const lease=await f.authority.lease(f.headers,{...f.base,request_id:'next',applied_snapshot_sha256:offered.snapshot.sha256});
 assert.equal(lease.policy_revision,3);assert.equal(lease.snapshot.revision,2);assert.equal(lease.snapshot.tuning.feedback_max_chars,80);
 f.settings.disable('test-admin');await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,request_id:'next2',applied_snapshot_sha256:offered.snapshot.sha256}),code('policy_disabled'));
 assert.equal((await f.authority.close(f.headers,{...f.base,request_id:'close'})).closed,true);
}finally{f.cleanup();}});
test('search cutoff truncates lease; expiry never silently resumes same entry',async()=>{const f=await testAuthority();try{
 const x=await f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null});f.setSourceUntil(f.now()+8000);
 const lease=await f.authority.lease(f.headers,{...f.base,request_id:'ok',applied_snapshot_sha256:x.snapshot.sha256});assert.equal(lease.lease_expires_at_ms,f.now()+8000);
 f.advance(8000);await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,request_id:'late',applied_snapshot_sha256:x.snapshot.sha256}));
}finally{f.cleanup();}});
test('close before first lease consumes entry; a delayed lease cannot reopen it',async()=>{const f=await testAuthority();try{
 await f.authority.close(f.headers,{...f.base,request_id:'close-before-lease'});
 await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null}),code('entry_closed'));
}finally{f.cleanup();}});
test('registry changes during asynchronous grant verification are rechecked',async()=>{const f=await testAuthority();try{
 const original=f.store.device.bind(f.store);let calls=0;
 f.store.device=(sn)=>{const result=original(sn);if(++calls===1)f.db.prepare('UPDATE device_registry SET account_id=? WHERE sn=?').run('other',sn);return result;};
 await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null}),code('device_changed'));
}finally{f.cleanup();}});
test('strict JWT matrix rejects missing expiry/issued-at, future, wrong algorithm/role/account/issuer/audience',async()=>{const f=await testAuthority();try{
 const sec=f.now()/1000;const payload={role:'device',accountId:'worker-service',iat:sec-1,exp:sec+600,iss:'p003',aud:'kidshub'};
 const variants=[{...payload,exp:undefined},{...payload,iat:undefined},{...payload,iat:sec+1},{...payload,exp:sec},{...payload,role:'admin'},{...payload,accountId:'another-worker'},{...payload,iss:'another'},{...payload,aud:'another'}];
 for(const p of variants){const token=await new SignJWT(p).setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(f.secrets.authSecret));
  await assert.rejects(()=>f.authority.lease({...f.headers,'x-p003-worker-token':token},{...f.base,applied_snapshot_sha256:null}),code('unauthorized'));}
 const wrongAlg=await new SignJWT(payload).setProtectedHeader({alg:'HS384'}).sign(new TextEncoder().encode(f.secrets.authSecret));
 await assert.rejects(()=>f.authority.lease({...f.headers,'x-p003-worker-token':wrongAlg},{...f.base,applied_snapshot_sha256:null}),code('unauthorized'));
 for(const p of [{kind:'p003-device',sub:f.sn,exp:sec+600},{kind:'p003-device',sub:f.sn,iat:sec},{kind:'p003-device',sub:f.sn,iat:sec+1,exp:sec+600}]){
  const credential=await new SignJWT(p).setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(f.secrets.authSecret));
  assert.equal(await f.authority.issue({...f.issueInput,credential:'Bearer '+credential,session_id:'missing-fields'}),null);}
}finally{f.cleanup();}});
test('readiness expires/withdraws, wrong config hash/build and changed worker roster never ready',async()=>{const f=await testAuthority();try{
 await f.authority.workerReady(f.serviceHeaders,{...f.readyAck,applied_config_sha256:'b'.repeat(64)});assert.equal(f.authority.runtime().ready,false);
 await f.authority.workerReady(f.serviceHeaders,{...f.readyAck,build_sha:'b'.repeat(40)});assert.equal(f.authority.runtime().ready,false);
 await f.authority.workerReady(f.serviceHeaders,f.readyAck);assert.equal(f.authority.runtime().ready,true);
 f.secrets.workerAccounts['rust-worker']='different-account';assert.equal(f.authority.runtime().ready,false);f.secrets.workerAccounts['rust-worker']='worker-service';
 await f.authority.workerReady(f.serviceHeaders,{...f.readyAck,registered:false});assert.equal(f.authority.runtime().ready,false);
 await f.authority.workerReady(f.serviceHeaders,f.readyAck);f.advance(15000);assert.equal(f.authority.runtime().ready,false);
}finally{f.cleanup();}});
test('entry expiration, allowlist/scene removal and session cap are authoritative',async()=>{for(const reason of ['expired-lease','allowlist','scene','max-session']){const f=await testAuthority();try{
 const offer=await f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null});await f.authority.lease(f.headers,{...f.base,request_id:'start',applied_snapshot_sha256:offer.snapshot.sha256});
 if(reason==='expired-lease'){f.advance(15000);await f.authority.workerReady(f.serviceHeaders,f.readyAck);}
 if(reason==='max-session'){f.advance(1800000);}
 if(reason==='allowlist'||reason==='scene'){const {revision,schema_version,...edit}=f.settings.read().config;f.settings.save(revision,{...edit,...(reason==='allowlist'?{allowlist:[]}:{scenes:['sharing']})},'synthetic');}
 await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,request_id:'renew',applied_snapshot_sha256:offer.snapshot.sha256}));
}finally{f.cleanup();}}});
test('observed revocation consumes old RTC session, including new entry IDs',async()=>{const f=await testAuthority();try{
 const offer=await f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null});await f.authority.lease(f.headers,{...f.base,request_id:'start',applied_snapshot_sha256:offer.snapshot.sha256});
 f.settings.disable('synthetic');await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,request_id:'revoked',applied_snapshot_sha256:offer.snapshot.sha256}),code('policy_disabled'));
 const {schema_version,revision,...edit}=f.settings.read().config;f.settings.save(revision,{...edit,enabled:true},'synthetic');
 const ack=await f.authority.workerReady(f.serviceHeaders,f.readyBody);await f.authority.workerReady(f.serviceHeaders,{...f.readyAck,applied_revision:ack.policy_revision,applied_config_sha256:ack.config_sha256});
 await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,request_id:'cannot-revive',applied_snapshot_sha256:offer.snapshot.sha256}),code('not_authorized'));
 await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,request_id:'explicit-new-entry',listening_id:f.base.session.trace_id+':2',mode_epoch:2,applied_snapshot_sha256:null}),code('not_authorized'));
 assert.ok(await f.authority.issue({...f.issueInput,session_id:'fresh-rtc-session'}));
}finally{f.cleanup();}});
test('off→on between lease polls is detected from configuration audit',async()=>{const f=await testAuthority();try{
 const offered=await f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null});f.settings.disable('synthetic');
 const {schema_version,revision,...edit}=f.settings.read().config;f.settings.save(revision,{...edit,enabled:true},'synthetic');
 const ack=await f.authority.workerReady(f.serviceHeaders,f.readyBody);await f.authority.workerReady(f.serviceHeaders,{...f.readyAck,applied_revision:ack.policy_revision,applied_config_sha256:ack.config_sha256});
 await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,request_id:'after-unobserved-toggle',applied_snapshot_sha256:offered.snapshot.sha256}),code('policy_disabled'));
 assert.equal(f.store.revoked(f.base.session.session_id),true);
}finally{f.cleanup();}});
test('missing current service key refuses optional signing; short configured entry deadline caps lease independently',async()=>{const f=await testAuthority();try{
 f.secrets.serviceKey='';assert.equal(await f.authority.issue({...f.issueInput,session_id:'missing-service'}),null);assert.equal(f.authority.runtime().ready,false);f.secrets.serviceKey='synthetic-service-key';
 const {schema_version,revision,...edit}=f.settings.read().config;f.settings.save(revision,{...edit,tuning:{...edit.tuning,max_session_sec:300}},'synthetic');
 const offer=await f.authority.lease(f.headers,{...f.base,applied_snapshot_sha256:null});assert.equal(f.store.entry(f.base.session.session_id,f.base.listening_id)?.deadline_ms,f.now()+300000);
 f.advance(290000);await f.authority.workerReady(f.serviceHeaders,f.readyAck);
 const lease=await f.authority.lease(f.headers,{...f.base,request_id:'near-entry-deadline',applied_snapshot_sha256:offer.snapshot.sha256});assert.equal(lease.lease_expires_at_ms,f.now()+10000);
 f.advance(10000);await f.authority.workerReady(f.serviceHeaders,f.readyAck);await assert.rejects(()=>f.authority.lease(f.headers,{...f.base,request_id:'entry-expired',applied_snapshot_sha256:offer.snapshot.sha256}),code('entry_closed'));
}finally{f.cleanup();}});
