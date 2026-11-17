/** Read queries against this task's synthetic run only; never a production URL. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
const root=resolve(process.argv[2]??''),name=process.argv[3]??'';
assert(root.includes('/p003-t5-')&&!root.includes('/server/data')&&realpathSync(root)===root);
assert.match(name,/^[a-z0-9-]{1,60}$/);
const config=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));assert.equal(config.synthetic,true);assert(config.devices>0&&config.devices<=1000);
const rounds=Number(process.env.T5_QUERY_ROUNDS??20);assert(Number.isInteger(rounds)&&rounds>0&&rounds<=100);
const file=join(root,name+'.jsonl'),resultFile=join(root,name+'.json');assert(!existsSync(file)&&!existsSync(resultFile));writeFileSync(file,'',{mode:0o600,flag:'wx'});
for(const domain of ['ACCOUNTS','DEVICES','PROFILE','CONFIG','CONVERSATION','FEEDBACK','ARK'])process.env[domain+'_DB_PATH']=join(root,domain.toLowerCase()+'.db');
assert(existsSync(join(root,'analytics.db'))&&existsSync(join(root,'ark.db')),'existing synthetic stores required');
const [{AnalyticsStore},{createAnalyticsApp},{ArkStore},{ArkRuntime}]=await Promise.all([import('../src/analytics/store.js'),import('../src/analytics/index.js'),import('../src/ark/store.js'),import('../src/ark/runtime.js')]);
const analytics=new AnalyticsStore(join(root,'analytics.db')),ark=new ArkStore(join(root,'ark.db'));
const ids=Array.from({length:config.devices},(_,i)=>({sn:'BJP003999999'+String(i+1).padStart(8,'0'),account_id:'t5-synthetic-'+i,epoch:1}));
const key=(sn:string)=>createHash('sha256').update(sn).digest('hex'),secret=randomBytes(32).toString('hex');
const reader={readCredentialState:()=>({binding:null,revokedThroughSec:null}),acceptsCredential:()=>false,readiness:()=>true,readAnalyticsDeviceContext:(sn:string)=>({deviceKey:key(sn),active:false,uploadEnabled:false,uploadHourCst:23}),arkDeviceKey:key,readArkAuthorization:(sn:string)=>{const id=ids.find(i=>i.sn===sn),g=id&&ark.grant(id);return id&&g?{...id,not_before_ms:g.not_before_ms}:null;}};
const app=createAnalyticsApp({store:analytics,reader,authSecret:secret,internalSecret:secret,controlPath:join(root,'control.json'),allowSubjects:[]});
const cgroup=()=>{if(process.platform!=='linux')return null;const p=readFileSync('/proc/self/cgroup','utf8').split('\n').find(x=>x.startsWith('0::'))?.slice(3);assert(p&&!p.includes('..'));const base=join('/sys/fs/cgroup',p);return {cpu_stat:readFileSync(join(base,'cpu.stat'),'utf8'),cpu_max:readFileSync(join(base,'cpu.max'),'utf8'),memory_current:readFileSync(join(base,'memory.current'),'utf8'),memory_max:readFileSync(join(base,'memory.max'),'utf8'),memory_events:readFileSync(join(base,'memory.events'),'utf8')};};
const cgroupBefore=cgroup();
const server=serve({fetch:async(request)=>{const began=performance.now(),r=await app.fetch(request);r.headers.set('X-T5-Service-Ms',String(performance.now()-began));return r;},hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
let observation:{status:number|null;body_complete:boolean;headers_ms:number|null;body_ms:number|null;service_ms:number|null}={status:null,body_complete:false,headers_ms:null,body_ms:null,service_ms:null};
const runtime=new ArkRuntime({workerAccountId:'synthetic-service',store:ark,readIdentity:sn=>ids.find(i=>i.sn===sn)??null,validAccount:()=>true,internalUrl:'http://127.0.0.1:'+(server.address() as any).port,internalSecret:secret,fetchImpl:async(input,init)=>{
 const target=observation,fetchStart=performance.now(),r=await fetch(input,init);target.status=r.status;target.headers_ms=performance.now()-fetchStart;target.service_ms=Number(r.headers.get('X-T5-Service-Ms'));
 if(!r.body)return r;
 return new Response(r.body.pipeThrough(new TransformStream({transform(chunk,controller){controller.enqueue(chunk);},flush(){target.body_complete=true;target.body_ms=performance.now()-fetchStart;}})),{status:r.status,headers:r.headers});
}});
const samples:number[]=[];let invalid=0,transport=0;
try{
 // Do not treat missing input fixtures as query success or guess the expected balance.
 for(const [i,id] of ids.entries()){const c=ark.current(id);assert.equal(c?.snapshot.source_mode,'normal');assert.equal(c?.snapshot.wallets.family_coin,100+i);assert.equal(c?.snapshot.inventory['M-CARD-001'],i%4);}
 for(let round=0;round<rounds;round++)for(const [actor,id] of ids.entries()){
  observation={status:null,body_complete:false,headers_ms:null,body_ms:null,service_ms:null};const start=performance.now(),answer=await runtime.preview(id.sn),ms=performance.now()-start;
  const correct=answer.facts_v1?.subject===id.sn&&answer.facts_v1?.assets.family_coin?.value===100+actor&&answer.facts_v1?.assets.stardust?.value===actor+1&&answer.facts_v1?.assets.makeup_card?.value===actor%4;
  const ok=observation.status===200&&observation.body_complete;invalid+=correct?0:1;transport+=ok?0:1;samples.push(ms);
  appendFileSync(file,JSON.stringify({at_ms:Date.now(),round,actor,ms,correct,...observation})+'\n');await new Promise(r=>setTimeout(r,50));
 }
 samples.sort((a,b)=>a-b);const q=(p:number)=>samples[Math.min(samples.length-1,Math.floor(samples.length*p))];
 const result={synthetic:true,cgroup_before:cgroupBefore,cgroup_after:cgroup(),scope:'actual ArkRuntime -> loopback HTTP -> readArkHistory/SQLite, no supplier or Android',devices:ids.length,samples:samples.length,p95_ms:q(.95),p99_ms:q(.99),invalid_facts:invalid,history_transport_failures:transport,shortest_internal_deadline_ms:120,required_margin_ms:20,pass:invalid===0&&transport===0&&q(.99)<=100};
 writeFileSync(resultFile,JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert(result.pass,'Ark mixed query gate');
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));ark.close();analytics.close();}
