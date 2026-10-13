// Numeric timings only, independent HTTP client process; never a capacity PASS.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SignJWT} from 'jose';
import {DatabaseSync} from 'node:sqlite';
const root='/opt/p003/analytics-staging-20261013',server=root+'/server';
assert.equal(process.cwd(),server);assert.equal(process.env.ANALYTICS_DB_PATH,server+'/data/analytics.db');
const subjects=process.env.ANALYTICS_SN_ALLOW.split(',');assert.equal(subjects.length,14);
const samples=JSON.parse(readFileSync('src/analytics/event-property-schema-v1.json','utf8')).events;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const prefix='http-timing-'+Date.now(),records=[];
const tokens=await Promise.all(subjects.map(sn=>new SignJWT({kind:'p003-device'}).setSubject(sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET))));
const counts=()=>{const db=new DatabaseSync(process.env.ANALYTICS_DB_PATH,{readOnly:true});try{return ['analytics_event','analytics_event_seen'].map(t=>Number(db.prepare('SELECT count(*) n FROM '+t).get().n));}finally{db.close();}};
const before=counts();let acknowledged=0;
const actors=await Promise.allSettled(subjects.map(async(_,actor)=>{
 await sleep(actor*125);
 for(let batch=0;batch<3;batch++){
  const requestId=prefix+'-'+actor+'-'+batch,now=Date.now();
  const events=Array.from({length:200},(_,i)=>{const s=samples[i%samples.length];return {schema_version:1,client_event_id:requestId+'-'+i,event_name:s.eventName,occurred_at_ms:now,session_id:'timing-session',sequence:i,priority:'normal',context:{},properties:structuredClone(s.sample)};});
  const body=JSON.stringify({schema_version:1,batch_id:requestId,sent_at_ms:now,client:{component:'synthetic_timing'},events});
  for(let attempt=0;;attempt++){
   assert.ok(attempt<8);
   const id=requestId+'-try-'+attempt,record={request_digest:createHash('sha256').update(id).digest('hex'),sent_ms:Date.now()};
   const response=await fetch('http://127.0.0.1:13306/v1/device/analytics/events:batch',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tokens[actor],'X-Request-Id':id},body,signal:AbortSignal.timeout(20000)});
   const ack=await response.json();record.done_ms=Date.now();record.status=response.status;records.push(record);
   if(response.status===200){assert.equal(ack.rejected.length,0);assert.equal(ack.accepted_event_ids.length+ack.duplicated_event_ids.length,200);acknowledged+=200;break;}
   assert.ok([429,503].includes(response.status));const seconds=Number(response.headers.get('Retry-After'));assert.ok(seconds>0&&seconds<=60);await sleep(seconds*1000+Math.floor(Math.random()*300));
  }
  await sleep(2000);
 }
}));
const after=counts(),report={diagnostic_only:true,synthetic_only:true,expected:8400,acknowledged,before,after,actor_failures:actors.filter(r=>r.status==='rejected').length,records};
const output=root+'/evidence/'+prefix+'.json';writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({output,acknowledged,actor_failures:report.actor_failures}));
