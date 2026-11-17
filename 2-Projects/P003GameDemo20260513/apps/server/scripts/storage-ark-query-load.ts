/** Read queries against this task's synthetic run only; never a production URL. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {fork,type ChildProcess} from 'node:child_process';
const root=resolve(process.argv[2]??''),name=process.argv[3]??'',readerMode=process.argv[4]==='reader';
assert(root.includes('/p003-t5-')&&!root.includes('/server/data')&&realpathSync(root)===root);
assert.match(name,/^[a-z0-9-]{1,60}$/);
const config=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));assert.equal(config.synthetic,true);assert(config.devices>0&&config.devices<=1000);
for(const domain of ['ACCOUNTS','DEVICES','PROFILE','CONFIG','CONVERSATION','FEEDBACK','ARK'])process.env[domain+'_DB_PATH']=join(root,domain.toLowerCase()+'.db');
assert(existsSync(join(root,'analytics.db'))&&existsSync(join(root,'ark.db')),'existing synthetic stores required');
const {ArkStore}=await import('../src/ark/store.js');
const ark=new ArkStore(join(root,'ark.db'));
const ids=Array.from({length:config.devices},(_,i)=>({sn:'BJP003999999'+String(i+1).padStart(8,'0'),account_id:'t5-synthetic-'+i,epoch:1}));
const key=(sn:string)=>createHash('sha256').update(sn).digest('hex');
const cgroup=()=>{
 if(process.platform!=='linux')return null;
 const p=readFileSync('/proc/self/cgroup','utf8').split('\n').find(x=>x.startsWith('0::'))?.slice(3);assert(p&&!p.includes('..'));const base=join('/sys/fs/cgroup',p);
 return Object.fromEntries(['cpu.stat','cpu.max','memory.current','memory.max','memory.events','memory.stat'].map(n=>[n,readFileSync(join(base,n),'utf8')]));
};
async function message(child:ChildProcess){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([once(child,'message').then(([v])=>v),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('reader startup timeout')),30000);})]) as any;}finally{clearTimeout(timer);}
}
if(readerMode){
 const [{AnalyticsStore},{createAnalyticsApp},{serve}]=await Promise.all([import('../src/analytics/store.js'),import('../src/analytics/index.js'),import('@hono/node-server')]);
 const configuration=once(process,'message');process.send?.({ready:true});const [{secret}]=await configuration;assert(typeof secret==='string'&&secret.length===64);
 const analytics=new AnalyticsStore(join(root,'analytics.db'));
 const reader={readCredentialState:()=>({binding:null,revokedThroughSec:null}),acceptsCredential:()=>false,readiness:()=>true,readAnalyticsDeviceContext:(sn:string)=>({deviceKey:key(sn),active:false,uploadEnabled:false,uploadHourCst:23}),arkDeviceKey:key,readArkAuthorization:(sn:string)=>{const id=ids.find(i=>i.sn===sn),g=id&&ark.grant(id);return id&&g?{...id,not_before_ms:g.not_before_ms}:null;}};
 const app=createAnalyticsApp({store:analytics,reader,authSecret:secret,internalSecret:secret,controlPath:join(root,'control.json'),allowSubjects:[]});
 const server=serve({fetch:async(request)=>{const start=performance.now(),r=await app.fetch(request),ms=performance.now()-start;r.headers.set('X-T5-Service-Ms',String(ms));appendFileSync(join(root,name+'.reader.jsonl'),JSON.stringify({at_ms:Date.now(),query_id:request.headers.get('X-T5-Query-Id'),ms,status:r.status})+'\n');return r;},hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 const stop=once(process,'message');process.send?.({url:'http://127.0.0.1:'+(server.address() as any).port});await stop;
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));analytics.close();ark.close();process.disconnect();
}else{
 const {ArkRuntime}=await import('../src/ark/runtime.js');
 const {warmArkHistory}=await import('../src/ark/warmup.js');
 const rounds=Number(process.env.T5_QUERY_ROUNDS??20);assert(Number.isInteger(rounds)&&rounds>0&&rounds<=100);
 const file=join(root,name+'.jsonl'),resultFile=join(root,name+'.json');assert(!existsSync(file)&&!existsSync(resultFile)&&!existsSync(join(root,name+'.reader.jsonl')));writeFileSync(file,'',{mode:0o600,flag:'wx'});
 const child=fork(fileURLToPath(import.meta.url),[root,name,'reader'],{execArgv:['--max-old-space-size=128','--import','tsx'],stdio:['ignore','inherit','inherit','ipc']});
 const secret=randomBytes(32).toString('hex'),cgroupBefore=cgroup();
 try{
  assert.equal((await message(child)).ready,true);const ready=message(child);child.send({secret});const {url}=await ready;assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/);
  // Match src/index.ts startup, including its existing shared one-second budget.
  // No device-fact request is discarded as "warmup"; retain this startup result.
  const warmStarted=performance.now(),warmup=await warmArkHistory({internalUrl:url,internalSecret:secret}),warmupMs=performance.now()-warmStarted;
  writeFileSync(join(root,name+'.startup.json'),JSON.stringify({warmup,ms:warmupMs,scope:'existing production startup; no measured device query excluded'}));assert.equal(warmup.status,'ready','production Ark startup must complete');
  let observation:any={};
  const runtime=new ArkRuntime({workerAccountId:'synthetic-service',store:ark,readIdentity:sn=>ids.find(i=>i.sn===sn)??null,validAccount:()=>true,internalUrl:url,internalSecret:secret,fetchImpl:async(input,init)=>{
   const target=observation,fetchStart=performance.now(),headers=new Headers(init?.headers);headers.set('X-T5-Query-Id',target.query_id);
   const r=await fetch(input,{...init,headers});target.status=r.status;target.headers_ms=performance.now()-fetchStart;target.service_ms=Number(r.headers.get('X-T5-Service-Ms'));
   if(!r.body)return r;
   return new Response(r.body.pipeThrough(new TransformStream({transform(chunk,controller){controller.enqueue(chunk);},flush(){target.body_complete=true;target.body_ms=performance.now()-fetchStart;}})),{status:r.status,headers:r.headers});
  }});
  const samples:number[]=[];let invalid=0,transport=0;
  for(const [i,id] of ids.entries()){const c=ark.current(id);assert.equal(c?.snapshot.source_mode,'normal');if(!config.continuous_ark)assert.equal(c?.snapshot.wallets.family_coin,100+i);else assert(c?.snapshot.snapshot_id.startsWith(`soak-${config.started_ms}-${i}-`));assert.equal(c?.snapshot.inventory['M-CARD-001'],i%4);}
  for(let round=0;round<rounds;round++)for(const [actor,id] of ids.entries()){
   observation={query_id:round+'-'+actor,status:null,body_complete:false,headers_ms:null,body_ms:null,service_ms:null};const before=ark.current(id)?.snapshot;
   const start=performance.now(),answer=await runtime.preview(id.sn),ms=performance.now()-start,after=ark.current(id)?.snapshot;
   const coin=answer.facts_v1?.assets.family_coin;
   const coinCorrect=config.continuous_ark?[before,after].some(s=>s&&coin?.value===s.wallets.family_coin&&coin?.occurred_at_ms===s.captured_at_ms):coin?.value===100+actor;
   const correct=answer.facts_v1?.subject===id.sn&&coinCorrect&&(config.continuous_ark?answer.facts_v1?.assets.stardust===null:answer.facts_v1?.assets.stardust?.value===actor+1)&&answer.facts_v1?.assets.makeup_card?.value===actor%4;
   const ok=observation.status===200&&observation.body_complete;invalid+=correct?0:1;transport+=ok?0:1;samples.push(ms);
   appendFileSync(file,JSON.stringify({at_ms:Date.now(),round,actor,ms,correct,...(config.continuous_ark?{before_snapshot_id:before?.snapshot_id,after_snapshot_id:after?.snapshot_id,coin_observed:coin,expected_coins:[before,after].filter(Boolean).map(s=>({value:s!.wallets.family_coin,at_ms:s!.captured_at_ms}))}:{}),...observation})+'\n');await new Promise(r=>setTimeout(r,50));
  }
  samples.sort((a,b)=>a-b);const q=(p:number)=>samples[Math.min(samples.length-1,Math.floor(samples.length*p))];
  const result={synthetic:true,topology:'separate Brain query client and Analytics reader processes; synthetic identity source',cgroup_before:cgroupBefore,cgroup_after:cgroup(),scope:'actual ArkRuntime -> loopback HTTP -> readArkHistory/SQLite, no supplier or Android',devices:ids.length,samples:samples.length,p95_ms:q(.95),p99_ms:q(.99),invalid_facts:invalid,history_transport_failures:transport,shortest_internal_deadline_ms:120,required_margin_ms:20,pass:invalid===0&&transport===0&&q(.99)<=100};
  writeFileSync(resultFile,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  assert(invalid===0&&transport===0,'Ark query facts or transport failed');
  if(process.env.T5_QUERY_OBSERVE!=='1')assert(result.pass,'Ark mixed query gate');
 }finally{
  if(child.connected){const closed=once(child,'exit');child.send({stop:true});let t:ReturnType<typeof setTimeout>|undefined;await Promise.race([closed,new Promise<void>(r=>{t=setTimeout(()=>{child.kill('SIGTERM');r();},5000);})]);clearTimeout(t);}else child.kill('SIGTERM');ark.close();
 }
}
