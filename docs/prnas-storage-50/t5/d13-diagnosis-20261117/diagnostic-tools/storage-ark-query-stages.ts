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
let stages:any[]=[];
 const contracts=await import('../src/ark/contracts.js');
 for(const [schema,method,label] of [[contracts.historyRequestSchema,'safeParse','request-schema'],[contracts.historySchema,'parse','response-schema']] as const){const old=(schema as any)[method].bind(schema);(schema as any)[method]=(...args:any[])=>{const start=performance.now();try{return old(...args);}finally{stages.push({label,ms:performance.now()-start});}};}
 (globalThis as any).__t5HistoryGate=(v:any)=>{stages.push({label:'history-gate',...v});};
 const {ArkStore}=await import('../src/ark/store.js');
const ark=new ArkStore(join(root,'ark.db'));const originalGrant=ark.grant.bind(ark);ark.grant=((...args:Parameters<typeof originalGrant>)=>{const at=performance.now();try{return originalGrant(...args);}finally{stages.push({label:'grant',ms:performance.now()-at});}}) as typeof ark.grant;
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
 const readMeters=()=>({cpu:process.cpuUsage(),io:readFileSync('/proc/self/io','utf8'),cgroup:cgroup()});
 let sqlSamples:any[]=[];
 const snapshot=analytics.readSnapshot.bind(analytics);analytics.readSnapshot=((fn:any)=>{const at=performance.now();try{return snapshot(fn);}finally{stages.push({label:'history-reduction-all',ms:performance.now()-at});}}) as typeof analytics.readSnapshot;
 const originalPrepare=analytics.db.prepare.bind(analytics.db);
 analytics.db.prepare=((sql:string)=>{const prepAt=performance.now(),statement=originalPrepare(sql),prepareMs=performance.now()-prepAt,label=sql.includes('json_extract(e.properties_json')?'evidence':sql.includes('g1.wallet_balance_changed')?'assets':sql.includes('g1.progress_checkpoint')?'daily':sql.startsWith('SELECT')?'other-select':'other';stages.push({label:'prepare-'+label,ms:prepareMs});return new Proxy(statement,{get(target,prop){const value=Reflect.get(target,prop,target);if(typeof value!=='function')return value;if(!['all','get','run'].includes(String(prop)))return value.bind(target);return (...args:any[])=>{const cpu=process.cpuUsage(),at=performance.now();try{return value.apply(target,args);}finally{sqlSamples.push({label,method:prop,ms:performance.now()-at,cpu:process.cpuUsage(cpu)});}};}});}) as typeof analytics.db.prepare;
 app.get('/t5/transport-warm',c=>c.json({ok:true}));
 const server=serve({fetch:async(request)=>{sqlSamples=[];stages=[];const before=readMeters(),start=performance.now(),r=await app.fetch(request),ms=performance.now()-start,after=readMeters();r.headers.set('X-T5-Service-Ms',String(ms));appendFileSync(join(root,name+'.reader.jsonl'),JSON.stringify({at_ms:Date.now(),query_id:request.headers.get('X-T5-Query-Id'),path:new URL(request.url).pathname,ms,status:r.status,before,after,sql:sqlSamples,stages})+'\n');return r;},hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 const stop=once(process,'message');process.send?.({url:'http://127.0.0.1:'+(server.address() as any).port});await stop;
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));analytics.close();ark.close();process.disconnect();
}else{
 const {ArkRuntime}=await import('../src/ark/runtime.js');
 const rounds=Number(process.env.T5_QUERY_ROUNDS??20);assert(Number.isInteger(rounds)&&rounds>0&&rounds<=100);
 const file=join(root,name+'.jsonl'),resultFile=join(root,name+'.json');assert(!existsSync(file)&&!existsSync(resultFile)&&!existsSync(join(root,name+'.reader.jsonl')));writeFileSync(file,'',{mode:0o600,flag:'wx'});
 const child=fork(fileURLToPath(import.meta.url),[root,name,'reader'],{execArgv:['--max-old-space-size=128','--import','tsx'],stdio:['ignore','inherit','inherit','ipc']});
 const secret=randomBytes(32).toString('hex'),cgroupBefore=cgroup();
 try{
  assert.equal((await message(child)).ready,true);const ready=message(child);child.send({secret});const {url}=await ready;assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/);
  if(process.env.T5_TRANSPORT_WARM==='1'){const r=await fetch(url+'/t5/transport-warm');assert.equal(r.status,200);await r.json();await new Promise(r=>setTimeout(r,250));}
  let observation:any={};
  const runtime=new ArkRuntime({workerAccountId:'synthetic-service',store:ark,readIdentity:sn=>ids.find(i=>i.sn===sn)??null,validAccount:()=>true,internalUrl:url,internalSecret:secret,fetchImpl:async(input,init)=>{
   const target=observation,fetchStart=performance.now();target.fetch_entered_ms=fetchStart-target.startPerf;init?.signal?.addEventListener('abort',()=>{target.abort_ms=performance.now()-target.startPerf;target.abort_phase=stages.some(s=>s.label==='history-gate')?'after-history-gate':'before-history-gate';},{once:true});const headers=new Headers(init?.headers);headers.set('X-T5-Query-Id',target.query_id);
   let r:Response;try{r=await fetch(input,{...init,headers});}catch(error){target.fetch_error=String(error);target.fetch_error_ms=performance.now()-target.startPerf;throw error;}target.status=r.status;target.headers_ms=performance.now()-fetchStart;target.service_ms=Number(r.headers.get('X-T5-Service-Ms'));
   if(!r.body)return r;
   return new Response(r.body.pipeThrough(new TransformStream({transform(chunk,controller){controller.enqueue(chunk);},flush(){target.body_complete=true;target.body_ms=performance.now()-fetchStart;}})),{status:r.status,headers:r.headers});
  }});
  const samples:number[]=[];let invalid=0,transport=0;
  for(const [i,id] of ids.entries()){const c=ark.current(id);assert.equal(c?.snapshot.source_mode,'normal');assert.equal(c?.snapshot.wallets.family_coin,100+i);assert.equal(c?.snapshot.inventory['M-CARD-001'],i%4);}
  for(let round=0;round<rounds;round++)for(const [actor,id] of ids.entries()){
   stages=[];observation={startPerf:performance.now(),query_id:round+'-'+actor,status:null,body_complete:false,headers_ms:null,body_ms:null,service_ms:null};const start=performance.now(),answer=await runtime.preview(id.sn),ms=performance.now()-start;
   const correct=answer.facts_v1?.subject===id.sn&&answer.facts_v1?.assets.family_coin?.value===100+actor&&answer.facts_v1?.assets.stardust?.value===actor+1&&answer.facts_v1?.assets.makeup_card?.value===actor%4;
   const ok=observation.status===200&&observation.body_complete;invalid+=correct?0:1;transport+=ok?0:1;samples.push(ms);
   appendFileSync(file,JSON.stringify({at_ms:Date.now(),round,actor,ms,correct,stages,...observation})+'\n');await new Promise(r=>setTimeout(r,50));
  }
  samples.sort((a,b)=>a-b);const q=(p:number)=>samples[Math.min(samples.length-1,Math.floor(samples.length*p))];
  const result={synthetic:true,topology:'separate Brain query client and Analytics reader processes; synthetic identity source',cgroup_before:cgroupBefore,cgroup_after:cgroup(),scope:'actual ArkRuntime -> loopback HTTP -> readArkHistory/SQLite, no supplier or Android',devices:ids.length,samples:samples.length,p95_ms:q(.95),p99_ms:q(.99),invalid_facts:invalid,history_transport_failures:transport,shortest_internal_deadline_ms:120,required_margin_ms:20,pass:invalid===0&&transport===0&&q(.99)<=100};
  writeFileSync(resultFile,JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert(result.pass,'Ark mixed query gate');
 }finally{
  if(child.connected){const closed=once(child,'exit');child.send({stop:true});let t:ReturnType<typeof setTimeout>|undefined;await Promise.race([closed,new Promise<void>(r=>{t=setTimeout(()=>{child.kill('SIGTERM');r();},5000);})]);clearTimeout(t);}else child.kill('SIGTERM');ark.close();
 }
}
