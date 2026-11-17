/** Test-only HTTP load generator. No server, database or writer imports. */
import assert from 'node:assert/strict';
import {writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {syntheticSessionId} from './storage-synthetic-identifiers.js';
export async function runCapacityClient(directory:string){
 const root=resolve(directory);assert(root.includes('p003-t5-')&&!root.includes('/server/data'),'synthetic directory required');
 const configPath=join(root,'config.json'),sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
 const config=JSON.parse(readFileSync(configPath,'utf8')),privateConfig=JSON.parse(readFileSync(join(root,'client-private.json'),'utf8'));assert.match(privateConfig.url,/^http:\/\/127\.0\.0\.1:\d+$/);
 const started=Date.now(),prefix='load-t5-'+config.seed+'-'+started,failures:any[]=[],arkRequests:any[]=[];let attempts=0,completed=0;
 for(const name of ['requests.jsonl','completed.jsonl'])writeFileSync(join(root,name),'',{flag:'wx',mode:0o600});
 let seed=config.seed;const random=()=>{seed=(seed*48271)%2147483647;return seed/2147483647;};
 const catalog=JSON.parse(readFileSync('src/analytics/event-property-schema-v1.json','utf8')).events;
 const sample=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
 const progress=setInterval(()=>console.log(JSON.stringify({progress:true,at:Date.now(),completed_batches:completed,attempts})),20000);
 const actors=await Promise.allSettled(privateConfig.tokens.map(async(token:string,actor:number)=>{
  const sessionId=syntheticSessionId(prefix+'-'+actor);
  const stamp=Date.now(),snapshot={...sample,snapshot_id:prefix+'-ark-'+actor,boot_id:prefix,boot_started_at_ms:stamp-1,captured_at_ms:stamp,sequence:1,logical_day:new Date(stamp+8*3600000).toISOString().slice(0,10),wallets:{family_coin:100+actor,stardust:actor+1},inventory:{'M-CARD-001':actor%4}};
  if(!config.continuous_ark){const ar=await fetch(privateConfig.url+'/t5/ark/state',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(20000)});const aj=await ar.json();arkRequests.push({actor,status:ar.status,result:aj});assert.equal(ar.status,200);assert.equal(aj.status,'accepted');}
  for(let offset=0;offset<config.events;offset+=config.batch){
   const events=Array.from({length:Math.min(config.batch,config.events-offset)},(_,i)=>{const n=offset+i,spec=catalog[n%catalog.length];return {schema_version:1,client_event_id:prefix+'-'+actor+'-'+n,event_name:spec.eventName,occurred_at_ms:config.continuous_ark?config.started_ms:started,session_id:sessionId,sequence:n,priority:'normal',context:{},properties:structuredClone(spec.sample)};});
   const ids=events.map(e=>e.client_event_id),body=JSON.stringify({schema_version:1,batch_id:prefix+'-'+actor+'-'+offset,sent_at_ms:started,client:{component:'synthetic-t5'},events});
   const batchStarted=performance.now();
   for(let attempt=0;;attempt++){
    assert.ok(Date.now()-started<config.deadline_ms,'load deadline exceeded');
    const start=performance.now(),sentAt=Date.now();let status=0,retry=0,j:any;
    try{const r=await fetch(privateConfig.url+'/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','X-Request-Id':prefix+'-'+actor+'-'+offset+'-'+attempt},body,signal:AbortSignal.timeout(20000)});status=r.status;retry=Number(r.headers.get('retry-after')??0)*1000;j=await r.json();}catch(e){j={error_code:'CLIENT_TRANSPORT',error:String(e)};retry=1000;}
    const finished=performance.now();
    const record={actor,offset,attempt,status,sent_at_ms:sentAt,finished_at_ms:Date.now(),ms:finished-start,batch_elapsed_ms:finished-batchStarted,retry_ms:retry,error:j.error_code??null};attempts++;appendFileSync(join(root,'requests.jsonl'),JSON.stringify(record)+'\n');
    if(status===200){
     try{assert.ok(j.ok&&j.rejected.length===0);assert.deepEqual([...j.accepted_event_ids,...j.duplicated_event_ids].sort(),[...ids].sort());}
     catch(error){appendFileSync(join(root,'failed-acks.jsonl'),JSON.stringify({actor,offset,attempt,ack:j})+'\n');throw error;}
     appendFileSync(join(root,'completed.jsonl'),JSON.stringify({actor,offset,ack:j})+'\n');completed++;break;
    }
    assert.ok(status===0||status===429||status===503,'terminal HTTP '+status);assert.ok(Number.isFinite(retry)&&retry>=0&&retry<=3600000,'invalid Retry-After');await sleep(Math.max(100,retry)+Math.floor(random()*1000));
   }
   await sleep(2000);
  }
 }));
 clearInterval(progress);actors.forEach((r,i)=>{if(r.status==='rejected')failures.push({actor:i,error:String(r.reason).slice(0,500)});});
 writeFileSync(join(root,'client-result.json'),JSON.stringify({evidence_version:3,prefix,completed_batches:completed,attempts,completed_file:'completed.jsonl',requests_file:'requests.jsonl',arkRequests,failures,duration_ms:Date.now()-started}));
 console.log(JSON.stringify({completed,attempts,failures}));if(failures.length)process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await runCapacityClient(process.argv[2]??'');
