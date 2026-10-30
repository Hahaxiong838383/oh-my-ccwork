// HTTP preflight is not a real RTC registration; session39 supplies that evidence.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {jwtVerify} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'p003-rtc-brain-test-')),out=join(dir,'instance'),input=join(dir,'input.json');
writeFileSync(input,JSON.stringify({agent:'p003-listening-p0-session39',build_sha:'a'.repeat(40),port:18748,rtc_credentials_kind:'synthetic_signing_only',synthetic_markers:['紫色小熊抱着金色南瓜']}),{mode:0o600});
const child=spawn(process.execPath,(process.env.P003_RTC_BRAIN_BUNDLE?['--experimental-sqlite',process.env.P003_RTC_BRAIN_BUNDLE,input,out]:['--experimental-sqlite','--import','tsx',resolve('scripts/listening-rtc-brain.ts'),input,out]),{env:{...process.env,LIVEKIT_URL:'wss://rtc.invalid',LIVEKIT_API_KEY:'synthetic-rtc-key',LIVEKIT_API_SECRET:'synthetic-rtc-secret-at-least-32-bytes'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
const base='http://127.0.0.1:18748';
try{
 let started=false;for(let n=0;n<100;n++){if(existsSync(join(out,'credentials.json'))){try{if((await fetch(base+'/health')).ok){started=true;break;}}catch{}}
 if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(started,'isolated entry did not start: '+logs);
 const creds=JSON.parse(readFileSync(join(out,'credentials.json'),'utf8'));
 const post=async(path:string,body:any,headers:Record<string,string>={})=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 const session=()=>post('/v1/device/session',{device_sn:creds.device_sn,trace_id:'p0-http-preflight',supports:['oneshot_first_turn_v1','local_receipt_v1','listening_mode_v1','listening_voice_control_v1']},{authorization:'Bearer '+creds.device_bearer});
 const before=await session();assert.equal(before.status,200);assert.equal(before.body.listening_contract,undefined);
 const ready={version:1,request_id:'p0-ready-1',agent:creds.agent,instance_id:'http-preflight-only',build_sha:'a'.repeat(40),registered:true,capabilities:creds.capabilities,applied_revision:null,applied_config_sha256:null};
 assert.equal((await post('/v1/internal/listening/worker-ready',ready)).status,401);
 const headers={authorization:'Bearer '+creds.service_bearer,'x-p003-worker-token':creds.worker_jwt};
 assert.equal((await post('/v1/internal/listening/worker-ready',{...ready,build_sha:'b'.repeat(40)},headers)).body.ready,false);
 const offer=await post('/v1/internal/listening/worker-ready',ready,headers);assert.equal(offer.status,200);assert.equal(offer.body.ready,false);
 assert.equal((await session()).body.listening_contract,undefined);
 const ack=await post('/v1/internal/listening/worker-ready',{...ready,request_id:'p0-ready-2',applied_revision:offer.body.policy_revision,applied_config_sha256:offer.body.config_sha256},headers);assert.equal(ack.status,200);assert.equal(ack.body.ready,true);
 const issued=await session();assert.equal(issued.status,200);assert.equal(issued.body.expected_agent_name,creds.agent);assert.equal(issued.body.contract.input_mode,'ordered_pcm');assert.ok(issued.body.listening_contract.voice_control);
 const {payload}=await jwtVerify(issued.body.token,new TextEncoder().encode('synthetic-rtc-secret-at-least-32-bytes'),{issuer:'synthetic-rtc-key'});
 const meta=JSON.parse((payload.roomConfig as any).agents[0].metadata);assert.equal(meta.listening.session.room,issued.body.room_name);assert.equal(meta.listening.session.trace_id,'p0-http-preflight');assert.equal(meta.listening.session.account_id,'p0-synthetic-account-38');
 const grantHeaders={...headers,'x-p003-listening-grant':meta.listening.grant};
 const common={version:1,request_id:'p0-lease-offer',session:meta.listening.session,listening_id:'p0-http-preflight:1',scene:'story',mode_epoch:1};
 const leaseOffer=await post('/v1/internal/listening/lease',{...common,applied_snapshot_sha256:null},grantHeaders);
 const lease=await post('/v1/internal/listening/lease',{...common,request_id:'p0-lease-ack',applied_snapshot_sha256:leaseOffer.body.snapshot.sha256},grantHeaders);assert.equal(lease.body.authorized,true);
 const summary=await post('/v1/internal/listening/summary',{...common,request_id:'p0-summary-tail',snapshot_revision:lease.body.snapshot.revision,snapshot_sha256:lease.body.snapshot.sha256,has_gap:false,base_summary_version:0,previous_summary:'',segments:[{seq:1,revision:1,text:'紫色小熊抱着金色南瓜'}]},grantHeaders);assert.equal(summary.status,200);
 const providerLog=JSON.parse(readFileSync(join(out,'provider-observations.json'),'utf8'));assert.equal(providerLog[0].trace_id,'p0-http-preflight');assert.equal(providerLog[0].request_id,'p0-summary-tail');assert.equal(providerLog[0].markers['紫色小熊抱着金色南瓜'],true);assert.ok(providerLog[0].chars>0);assert.match(providerLog[0].sha256,/^[a-f0-9]{64}$/);assert.equal(providerLog[0].userText,undefined);
 const status:any=await (await fetch(base+'/health')).json();assert.equal(status.boundaries.clock,'Date.now');assert.equal(status.boundaries.provider,'synthetic_text_only');assert.equal(status.boundaries.rtc_credentials,'synthetic_signing_only');
 await post('/v1/internal/listening/worker-ready',{...ready,request_id:'p0-withdraw',registered:false},headers);assert.equal((await session()).body.listening_contract,undefined);
 assert.ok(!logs.includes(creds.worker_jwt));assert.ok(!logs.includes(creds.service_bearer));
 console.log('PASS isolated real-route preflight: no readiness seed; auth/build/config ACK; signed dispatch; withdrawal; explicit provider boundary');
}finally{child.kill('SIGTERM');await new Promise<void>(r=>{if(child.exitCode!==null)r();else child.once('exit',()=>r());});rmSync(dir,{recursive:true,force:true});}
