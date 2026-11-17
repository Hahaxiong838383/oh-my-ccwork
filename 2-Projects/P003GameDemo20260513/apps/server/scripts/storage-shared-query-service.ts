/** Test-only persistent Brain reader. Uses the SAME HTTP receiver as the load. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync,statfsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
import {Hono} from 'hono';
import {createArkArchiveControl} from '../src/ark/archive-control.js';
const root=resolve(process.argv[2]??'');
assert(root.includes('/p003-t5-')&&!root.includes('/server/data')&&realpathSync(root)===root);
const config=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));assert(config.synthetic&&config.continuous_ark);
for(const domain of ['ACCOUNTS','DEVICES','PROFILE','CONFIG','CONVERSATION','FEEDBACK','ARK'])process.env[domain+'_DB_PATH']=join(root,domain.toLowerCase()+'.db');
const [{ArkStore},{ArkRuntime},{warmArkHistory},{createArkRoutes}]=await Promise.all([import('../src/ark/store.js'),import('../src/ark/runtime.js'),import('../src/ark/warmup.js'),import('../src/ark/routes.js')]);
// Open once before the producer starts, like the persistent production service.
const ark=new ArkStore(join(root,'ark.db'),undefined,()=>({enabled:true,limitBytes:8*1024**3,reserveBytes:4.5*1024**3,freeBytes:Number(statfsSync(root).bavail)*Number(statfsSync(root).bsize)}));
const accept=ark.accept.bind(ark);ark.accept=(...args)=>{try{return accept(...args);}catch(error){
 const e=error as {name?:string;code?:string;errcode?:number};
 appendFileSync(join(root,'ark-accept-errors.jsonl'),JSON.stringify({at_ms:Date.now(),pid:process.pid,name:e.name??null,code:e.code??null,sqlite_code:e.errcode??null})+'\n');throw error;
}};
const ids=Array.from({length:config.devices},(_,i)=>({sn:'BJP003999999'+String(i+1).padStart(8,'0'),account_id:'t5-synthetic-'+i,epoch:1}));
let runtime:InstanceType<typeof ArkRuntime>|undefined,observation:any={},busy=false,server:ReturnType<typeof serve>|undefined;
async function cycle(name:string){
 assert.match(name,/^[a-z0-9-]{1,60}$/);assert(runtime);
 const file=join(root,name+'.jsonl'),resultFile=join(root,name+'.json');assert(!existsSync(file)&&!existsSync(resultFile));
 writeFileSync(file,'',{flag:'wx',mode:0o600});const samples:number[]=[];let invalid=0,transport=0;
 for(const [actor,id]of ids.entries()){
  observation={query_id:name+'-'+actor,status:null,body_complete:false,headers_ms:null,body_ms:null,service_ms:null,receiver_pid:null};
  const before=ark.current(id)?.snapshot,sent=Date.now(),started=performance.now(),answer=await runtime.preview(id.sn),ms=performance.now()-started,after=ark.current(id)?.snapshot;
  const coin=answer.facts_v1?.assets.family_coin,card=answer.facts_v1?.assets.makeup_card,star=answer.facts_v1?.assets.stardust;
  const correct=answer.facts_v1?.subject===id.sn&&[before,after].some(s=>s&&coin?.value===s.wallets.family_coin&&coin?.occurred_at_ms===s.captured_at_ms)&&star===null&&card?.value===actor%4;
  const ok=observation.status===200&&observation.body_complete&&observation.receiver_pid===config.receiver_pid;
  invalid+=correct?0:1;transport+=ok?0:1;samples.push(ms);
  appendFileSync(file,JSON.stringify({sent_at_ms:sent,at_ms:Date.now(),actor,ms,correct,before_snapshot_id:before?.snapshot_id,after_snapshot_id:after?.snapshot_id,coin_observed:coin,card_observed:card,stardust_observed:star,expected_coins:[before,after].filter(Boolean).map(s=>({value:s!.wallets.family_coin,at_ms:s!.captured_at_ms})),...observation})+'\n');
  await new Promise(r=>setTimeout(r,50));
 }
 samples.sort((a,b)=>a-b);const q=(p:number)=>samples[Math.min(samples.length-1,Math.floor(samples.length*p))];
 const result={synthetic:true,topology:'persistent Brain client -> same Analytics HTTP receiver handling ingestion',pid:process.pid,receiver_pid:config.receiver_pid,devices:ids.length,samples:samples.length,p95_ms:q(.95),p99_ms:q(.99),invalid_facts:invalid,history_transport_failures:transport,pass:invalid===0&&transport===0&&q(.99)<=100};
 writeFileSync(resultFile,JSON.stringify(result,null,2));
 // Parent aggregates every sample and enforces the unchanged global P99 gate.
 return invalid===0&&transport===0?0:1;
}
process.on('message',async(message:any)=>{
 const id=message?.id;
 if(busy){process.send?.({id,error:'query_service_busy'});return;}
 busy=true;
 try{
  if(message.type==='configure'){
   assert(!runtime);assert.match(message.url,/^http:\/\/127\.0\.0\.1:\d+$/);assert.match(message.secret,/^[a-f0-9]{64}$/);
   const started=performance.now(),warmup=await warmArkHistory({internalUrl:message.url,internalSecret:message.secret});
   writeFileSync(join(root,'shared-query.startup.json'),JSON.stringify({warmup,ms:performance.now()-started,pid:process.pid,receiver_pid:config.receiver_pid,scope:'one existing production startup budget, no discarded device sample'}));
   runtime=new ArkRuntime({workerAccountId:'synthetic-service',store:ark,readIdentity:sn=>ids.find(i=>i.sn===sn)??null,validAccount:()=>true,internalUrl:message.url,internalSecret:message.secret,fetchImpl:async(input,init)=>{
    const target=observation,start=performance.now(),headers=new Headers(init?.headers);headers.set('X-T5-Query-Id',target.query_id);
    const r=await fetch(input,{...init,headers});target.status=r.status;target.headers_ms=performance.now()-start;target.service_ms=Number(r.headers.get('X-T5-Service-Ms'));target.receiver_pid=Number(r.headers.get('X-T5-Receiver-Pid'));
    if(!r.body)return r;
    return new Response(r.body.pipeThrough(new TransformStream({transform(chunk,controller){controller.enqueue(chunk);},flush(){target.body_complete=true;target.body_ms=performance.now()-start;}})),{status:r.status,headers:r.headers});
   }});
   // The production Brain owns Ark POST/current; Analytics owns raw history.
   // Reuse this existing child so the test has the same two event loops and
   // counts all of them against the original shared resource budget.
   const app=new Hono();app.route('/internal/ark-archive',createArkArchiveControl({store:()=>ark,secret:()=>message.secret,enabled:()=>process.env.T5_ARK_SINGLE_WRITER==='1'}));app.route('/t5/ark',createArkRoutes({store:()=>ark,runtime:()=>runtime!,secret:()=>message.secret,ceiling:()=>ids.map(i=>i.sn),acceptsCredential:()=>true,isAdmin:()=>false}));
   server=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{const r=await app.fetch(request);r.headers.set('X-T5-Brain-Pid',String(process.pid));return r;}});
   if(!server.listening)await once(server,'listening');
   const arkUrl='http://127.0.0.1:'+(server.address()as any).port+'/t5/ark/state';
   writeFileSync(join(root,'brain-topology.json'),JSON.stringify({brain_pid:process.pid,receiver_pid:config.receiver_pid,ark_url:arkUrl,scope:'same-existing-child-same-test-cgroup'}));
   process.send?.({id,exit:0,brain_pid:process.pid,ark_url:arkUrl,ark_control_url:new URL('/internal/ark-archive',arkUrl).href});
  }else if(message.type==='query')process.send?.({id,exit:await cycle(message.name)});
  else if(message.type==='stop'){if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}ark.close();process.send?.({id,exit:0});process.disconnect();}
  else throw Error('invalid_query_message');
 }catch(error){process.send?.({id,error:String(error)});}finally{busy=false;}
});
process.send?.({id:'boot',exit:0});
