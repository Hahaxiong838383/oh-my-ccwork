import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {SignJWT} from 'jose';
const {AnalyticsStore}=await import('../src/analytics/store.js');
const {AnalyticsWriter}=await import('../src/analytics/writer.js');
const {createAnalyticsApp}=await import('../src/analytics/index.js');
const {validateAnalyticsEvent,canonicalJson}=await import('../src/analytics/contracts.js');
const dir=mkdtempSync(join(tmpdir(),'analytics-structure-'));const store=new AnalyticsStore(join(dir,'analytics.db'));
const writer=new AnalyticsWriter(store.path);
try{
const workerDeadline=Date.now()+5000;while(!writer.ready){assert.ok(Date.now()<workerDeadline,'writer startup');await new Promise(resolve=>setTimeout(resolve,5));}
const control=join(dir,'control.json');writeFileSync(control,'{"enabled":true}',{mode:0o600});
const app=createAnalyticsApp({store,writer,reader:{acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:()=>({deviceKey:'a'.repeat(64),active:true,uploadEnabled:true,uploadHourCst:23})},authSecret:'fake',internalSecret:'fake-internal',controlPath:control,allowSubjects:['FAKE'],diskFreeBytes:()=>20*1024**3});
const token=await new SignJWT({kind:'p003-device'}).setSubject('FAKE').setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode('fake'));
const event=(id:string)=>({schema_version:1,client_event_id:id,event_name:'app.bridge_ready',occurred_at_ms:Date.now(),session_id:'s',sequence:1,priority:'normal',context:{},properties:{}});
const deep=(id:string,depth:number,leaf=0)=>JSON.stringify(event(id)).replace('"properties":{}','"properties":{"extra":'+'['.repeat(depth)+leaf+']'.repeat(depth)+'}');
const post=async(events:string[],request:string)=>app.request('/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':request},body:'{"schema_version":1,"batch_id":"deep-batch","sent_at_ms":1,"client":{},"events":['+events.join(',')+']}'});
const poison=deep('deep',4000);
let response=await post([JSON.stringify(event('good')),poison],'mixed');
assert.equal(response.status,200,'一个深事件必须200终态结算，不能回滚正常事件并整批503');
let ack=await response.json();assert.deepEqual(ack.accepted_event_ids,['good']);assert.deepEqual(ack.duplicated_event_ids,[]);assert.deepEqual(ack.rejected,[{client_event_id:'deep',reason:'invalid_event'}]);
assert.deepEqual([...ack.accepted_event_ids,...ack.duplicated_event_ids,...ack.rejected.map((x:any)=>x.client_event_id)].sort(),['deep','good']);
assert.deepEqual(validateAnalyticsEvent(JSON.parse(poison)),{ok:false,reason:'invalid_event'});
assert.throws(()=>canonicalJson(JSON.parse(poison)),/INVALID_EVENT_STRUCTURE/);
response=await post([deep('identical',4000),deep('identical',4000)],'same-deep');assert.equal(response.status,200);ack=await response.json();assert.deepEqual(ack.rejected,[{client_event_id:'identical',reason:'invalid_event'}]);
response=await post([deep('conflict',4000,0),deep('conflict',4000,1)],'conflicting-deep');assert.equal(response.status,200);ack=await response.json();assert.deepEqual(ack.rejected,[{client_event_id:'conflict',reason:'client_event_id_conflict'}]);
response=await post([JSON.stringify(event('mixed-id')),deep('mixed-id',10000)],'valid-deep-conflict');assert.equal(response.status,200);ack=await response.json();assert.deepEqual(ack.rejected,[{client_event_id:'mixed-id',reason:'client_event_id_conflict'}]);
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,1);
}finally{await writer.close();store.close();rmSync(dir,{recursive:true,force:true});}
console.log('analytics structure: PASS (real worker transport, 4000/10000-depth terminal ACK, complete/disjoint sets, same-ID conflicts)');
