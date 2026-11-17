/** Synthetic device-side HTTP producer. Not on either server's event loop. */
import assert from 'node:assert/strict';
import {parentPort,workerData as c} from 'node:worker_threads';
import {readFileSync,appendFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
assert(c.root.includes('/p003-t5-')&&realpathSync(c.root)===c.root);
assert.match(c.url,/^http:\/\/127\.0\.0\.1:\d+\/t5\/ark\/state$/);
assert(Number.isSafeInteger(c.brainPid)&&c.brainPid!==process.pid);
assert(c.tokens.length>0&&c.tokens.length<=1000&&c.durationMs>0&&c.durationMs<=86400000&&c.intervalMs>0);
const stop=new Int32Array(c.stop),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sample=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
const started=performance.now();let rounds=0;
try{
 for(let round=0;!Atomics.load(stop,0)&&performance.now()-started<c.durationMs;round++){
  const due=started+round*c.intervalMs;
  while(!Atomics.load(stop,0)&&performance.now()<due)await sleep(Math.min(1000,due-performance.now()));
  if(Atomics.load(stop,0)||performance.now()-started>=c.durationMs)break;
  for(const [actor,token]of c.tokens.entries()){
   const now=Date.now(),snapshot={...sample,snapshot_id:`soak-${c.startedMs}-${actor}-${round}`,boot_id:`soak-${c.startedMs}`,boot_started_at_ms:c.startedMs-1,captured_at_ms:now,sequence:round+1,logical_day:new Date(now+8*3600000).toISOString().slice(0,10),source_mode:'normal',wallets:{family_coin:round+actor,stardust:null},inventory:{'M-CARD-001':actor%4}};
   const began=performance.now();let r,body,brainPid=null,error=null;
   try{r=await fetch(c.url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(5000)});body=await r.json();brainPid=Number(r.headers.get('X-T5-Brain-Pid'));}
   catch(e){error=String(e);throw e;}
   finally{appendFileSync(join(c.root,'ark-continuous.jsonl'),JSON.stringify({at_ms:now,actor,round,snapshot_id:snapshot.snapshot_id,status:r?.status??null,body:body??null,error,ms:performance.now()-began,brain_pid:brainPid,receiver_pid:process.pid,producer_thread:true})+'\n');}
   assert.equal(brainPid,c.brainPid);assert.equal(r.status,200);assert.equal(body.status,'accepted');
  }
  rounds++;parentPort.postMessage({type:'round',rounds});
 }
 const result={ok:true,rounds,elapsed_ms:performance.now()-started,stopped:!!Atomics.load(stop,0)};
 writeFileSync(join(c.root,'ark-producer-result.json'),JSON.stringify(result));parentPort.postMessage({type:'done',...result});
}catch(error){writeFileSync(join(c.root,'ark-producer-result.json'),JSON.stringify({ok:false,rounds,error:String(error)}));throw error;}
