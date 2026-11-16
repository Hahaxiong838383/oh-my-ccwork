/** Synthetic, isolated maintenance + real localhost HTTP/writer. Never target a live DB. */
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
import {AnalyticsStore,cstDay,DAY_MS} from '../src/analytics/store.js';
import {AnalyticsCheckpointer} from '../src/analytics/checkpointer.js';
import {AnalyticsWriter} from '../src/analytics/writer.js';
import {createAnalyticsApp} from '../src/analytics/index.js';
import * as rollup from '../src/analytics/rollup.js';
const mode=process.argv[2],root=resolve(process.argv[3]??'');
assert.ok(root.includes('t4-')&&!root.includes('/server/data'),'isolated t4 directory required');
mkdirSync(root,{recursive:true});const path=join(root,'synthetic.db'),now=Date.parse('2026-11-16T12:00:00Z');
if(mode==='prepare'){
 assert.equal(existsSync(path),false,'never overwrite a database');const s=new AnalyticsStore(path),day=cstDay(now),old=cstDay(now-91*DAY_MS),rawTime=now-15*DAY_MS;
 const f=s.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)'),ev=s.db.prepare('INSERT INTO analytics_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
 const batch=s.db.prepare('INSERT INTO analytics_batch VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),settle=s.db.prepare('INSERT INTO analytics_settlement VALUES (?,?,?,?)'),seen=s.db.prepare('INSERT INTO analytics_event_seen VALUES (?,?,?,?)');
 const start=performance.now();
 // A whole 50-device day's facts in two dimensions, plus one expired day. Not a 90-day load test.
 for(let base=0;base<300000;base+=1000){s.transaction(()=>{for(let i=base;i<base+1000;i++){
  const device='synthetic-'+String(i%50).padStart(2,'0'),id=String(i).padStart(8,'0'),attempt='b'+Math.floor(i/200);
  for(const dim of ['occurred','received']){f.run(dim,day,device,id,'app.bridge_ready','s',0,'{}',now);f.run(dim,old,device,id,'app.bridge_ready','s',0,'{}',rawTime);}
  ev.run(device,id,'app.bridge_ready',rawTime,rawTime,'s',i,'normal','{}','{}',attempt,cstDay(rawTime),cstDay(rawTime),0);
  if(i%200===0)batch.run(attempt,attempt,attempt,device,rawTime,rawTime,'{}',200,0,0,200,1);
  settle.run(attempt,id,'accepted',null);seen.run(device,id,'synthetic-hash',rawTime);
 }});if(base%10000===0)s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}
 s.db.prepare('INSERT INTO analytics_dirty_day VALUES (?,?)').run('received',day);
 s.db.prepare('INSERT INTO analytics_dirty_day VALUES (?,?)').run('occurred',day);
 s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');s.close();writeFileSync(join(root,'PREPARED.json'),JSON.stringify({facts:1200000,raw:300000,seen:300000}));console.log(JSON.stringify({synthetic:true,facts:1200000,raw:300000,seen:300000,settlements:300000,batches:1500,bytes:statSync(path).size,build_ms:performance.now()-start}));
}else if(mode==='maintenance'){
 const s=new AnalyticsStore(path);const tx:number[]=[],writes:number[]=[];let began:number|undefined;
 const exec=s.db.exec.bind(s.db),prepare=s.db.prepare.bind(s.db);
 s.db.exec=((sql:string)=>{if(sql==='BEGIN IMMEDIATE')began=performance.now();const result=exec(sql);if(sql==='COMMIT'||sql==='ROLLBACK'){if(began!==undefined)tx.push(performance.now()-began);began=undefined;}return result;}) as any;
 s.db.prepare=((sql:string)=>{const st=prepare(sql);if(sql.startsWith('DELETE FROM analytics_device_day WHERE dimension=? AND day=?')){const run=st.run.bind(st);st.run=((...args:any[])=>{began=performance.now();return run(...args);}) as any;}return st;}) as any;
 const start=performance.now(),scanStart=performance.now(),r=rollup.rollupDirtyDaysWithStatus(s,now,2);const scanMs=performance.now()-scanStart;
 writes.push(...tx);tx.length=0;
 let facts=0,events=0,batches=0,cycles=0,ms=0;
 if(rollup.pruneAnalyticsCycle){for(;cycles<1;cycles++){const p=await rollup.pruneAnalyticsCycle(s,now);facts+=p.facts;events+=p.events;batches+=p.batches;ms+=p.elapsed_ms;if(!p.budget_exhausted){cycles++;break;}}}
 else {const t=performance.now(),p=rollup.pruneAnalytics(s,now,1000);events=p.events;batches=p.batches;ms=performance.now()-t;cycles=1;facts=1000;}
 // After the concurrent requests stop, an explicit quiet retry must converge without losing facts.
 s.close();console.log(JSON.stringify({rollup:r,rollup_ms:scanMs,rollup_write_ms:writes,prune:{facts,events,batches,cycles,elapsed_ms:ms,max_transaction_ms:Math.max(0,...tx),p95_transaction_ms:[...tx].sort((a,b)=>a-b)[Math.floor(tx.length*.95)]},elapsed_ms:performance.now()-start}));
}else if(mode==='http'){
 assert.ok(existsSync(join(root,'PREPARED.json')),'prepare must complete before HTTP benchmark');
 const s=new AnalyticsStore(path),writer=new AnalyticsWriter(path),control=join(root,'control.json');writeFileSync(control,'{"enabled":true}',{mode:0o600});
 while(!writer.ready)await new Promise(r=>setTimeout(r,10));
 const checkpointer=new AnalyticsCheckpointer(path);checkpointer.start();
 const ctx={deviceKey:'t4-http-synthetic',active:true,uploadEnabled:true,uploadHourCst:23},secret='isolated-synthetic-key';
 const app=createAnalyticsApp({store:s,writer,reader:{readCredentialState:()=>({binding:null,revokedThroughSec:null}),acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:()=>ctx},authSecret:secret,internalSecret:'isolated',controlPath:control,allowSubjects:['T4-SYNTHETIC'],diskFreeBytes:()=>20*1024**3});
 const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await new Promise<void>(r=>server.listening?r():server.once('listening',r));const addr=server.address() as any;
 const token=await new SignJWT({kind:'p003-device'}).setSubject('T4-SYNTHETIC').setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 let childDone=false,stdout='',stderr='';const child=spawn(process.execPath,['--import','tsx','scripts/analytics-t4-benchmark.ts','maintenance',root],{cwd:process.cwd(),env:process.env});
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const exited=new Promise<number|null>(r=>child.on('exit',c=>{childDone=true;r(c);}));
 const acks:{code:number;ms:number;accepted:number}[]=[];
 try{
  for(let i=0;i<50;i++){
   const t=performance.now(),id='t4-http-'+i,received=Date.now();
   const r=await fetch('http://127.0.0.1:'+addr.port+'/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':id},body:JSON.stringify({schema_version:1,batch_id:id,sent_at_ms:received,client:{},events:[{schema_version:1,client_event_id:id,event_name:'app.bridge_ready',occurred_at_ms:received,session_id:'s',sequence:i,priority:'normal',context:{},properties:{}}]})});const j=await r.json();acks.push({code:r.status,ms:performance.now()-t,accepted:j.accepted_event_ids?.length??0});await new Promise(r=>setTimeout(r,100));
  }
  const code=await exited;assert.equal(code,0,stderr);const maintenance=JSON.parse(stdout.trim());
  const quiet=rollup.rollupDirtyDaysWithStatus(s,now,16);assert.equal(quiet.partial,false);
  const count=(table:string)=>Number(s.db.prepare('SELECT count(*) n FROM '+table).get()!.n),latency=acks.map(x=>x.ms).sort((a,b)=>a-b);
  const result={synthetic:true,host:process.platform,node:process.version,maintenance,quiet,acks:{count:acks.length,accepted:acks.reduce((a,x)=>a+x.accepted,0),codes:acks.reduce((a,x)=>(a[x.code]=(a[x.code]??0)+1,a),{} as Record<string,number>),p95:latency[Math.floor(latency.length*.95)],p99:latency[Math.floor(latency.length*.99)],max:latency.at(-1)},checkpoint:checkpointer.status(),rows:{facts:count('analytics_rollup_fact'),raw:count('analytics_event'),seen:count('analytics_event_seen'),settlements:count('analytics_settlement')},database_bytes:statSync(path).size,rss:process.memoryUsage().rss};
  console.log(JSON.stringify(result));writeFileSync(join(root,'RESULT.json'),JSON.stringify(result,null,2));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writer.close();await checkpointer.stop();s.close();}
}else throw new Error('prepare | maintenance | http');
