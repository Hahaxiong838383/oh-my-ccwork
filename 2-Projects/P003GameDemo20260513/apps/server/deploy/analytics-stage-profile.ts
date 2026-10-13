// Isolated diagnostic bootstrap. Never loaded by the production PM2 entrypoint.
// Records numeric SQL timings only; no SQL arguments, event bodies or credentials.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {analyticsOptionsFromEnv,startAnalyticsServer} from '../src/analytics/index.js';

const stage='/opt/p003/analytics-staging-20261013';
assert.equal(resolve(process.cwd()),stage+'/server');
assert.equal(process.env.ANALYTICS_DB_PATH,stage+'/server/data/analytics.db');
const options=analyticsOptionsFromEnv(),store=options.store;
type Sample={at_ms:number;duration_ms:number;phases_ms:Record<string,number>;calls:Record<string,number>;wal_before:number;wal_after:number;rss_bytes:number;ok:boolean};
let active:Sample|undefined,total=0;const samples:Sample[]=[];
type HttpTiming={request_digest:string;incoming_ms:number;transaction_start_ms?:number;transaction_end_ms?:number;writer_dispatch_ms?:number;writer_ack_ms?:number;end_called_ms?:number;finish_ms?:number;status?:number};
const httpContext=new AsyncLocalStorage<HttpTiming>(),httpTimings:HttpTiming[]=[];
function timed<T>(phase:string,fn:()=>T):T{
  if(!active)return fn();const sample=active,began=performance.now();
  try{return fn();}finally{sample.phases_ms[phase]=(sample.phases_ms[phase]??0)+performance.now()-began;sample.calls[phase]=(sample.calls[phase]??0)+1;}
}
const exec=store.db.exec.bind(store.db),prepare=store.db.prepare.bind(store.db);
store.db.exec=(sql:string)=>timed(sql.trim().split(/\s+/)[0].toUpperCase(),()=>exec(sql));
store.db.prepare=((sql:string)=>{
  const statement=prepare(sql),phase=(/\b(?:FROM|INTO|UPDATE)\s+(analytics_\w+)/i.exec(sql)?.[1]??'other');
  return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);
    if(typeof value!=='function')return value;
    return (...args:unknown[])=>timed(phase,()=>Reflect.apply(value,target,args));
  }});
}) as typeof store.db.prepare;
const transaction=store.transaction.bind(store);
store.transaction=<T>(fn:()=>T):T=>{
  const parent=active,sample:Sample={at_ms:Date.now(),duration_ms:0,phases_ms:{},calls:{},wal_before:store.walBytes(),wal_after:0,rss_bytes:0,ok:false};
  active=sample;const began=performance.now();
  const http=httpContext.getStore();if(http)http.transaction_start_ms=Date.now();
  try{const result=transaction(fn);sample.ok=true;return result;}
  finally{if(http)http.transaction_end_ms=Date.now();sample.duration_ms=performance.now()-began;sample.wal_after=store.walBytes();sample.rss_bytes=process.memoryUsage().rss;active=parent;total++;if(samples.length<1200)samples.push(sample);}
};
const delay=monitorEventLoopDelay({resolution:10});delay.enable();
const lifecycle=startAnalyticsServer(options,3306);
// This clock spans IPC + the durable worker transaction, not SQL-only timing.
const settle=lifecycle.writer.settle.bind(lifecycle.writer);
lifecycle.writer.settle=async(...args:Parameters<typeof settle>)=>{
  const http=httpContext.getStore(),began=performance.now();
  const sample:Sample={at_ms:Date.now(),duration_ms:0,phases_ms:{},calls:{worker_roundtrip:1},wal_before:store.walBytes(),wal_after:0,rss_bytes:0,ok:false};
  if(http)http.writer_dispatch_ms=Date.now();
  try{const result=await settle(...args);sample.ok=true;return result;}
  finally{if(http)http.writer_ack_ms=Date.now();sample.duration_ms=performance.now()-began;sample.phases_ms.worker_roundtrip=sample.duration_ms;sample.wal_after=store.walBytes();sample.rss_bytes=process.memoryUsage().rss;total++;if(samples.length<1200)samples.push(sample);}
};
const handlers=lifecycle.server.listeners('request');assert.equal(handlers.length,1);
lifecycle.server.removeAllListeners('request');
lifecycle.server.on('request',(request,response)=>{
  if(request.url!=='/v1/device/analytics/events:batch')return handlers[0].call(lifecycle.server,request,response);
  const timing:HttpTiming={request_digest:createHash('sha256').update(String(request.headers['x-request-id']??'')).digest('hex'),incoming_ms:Date.now()};
  if(httpTimings.length<2000)httpTimings.push(timing);
  const end=response.end;
  response.end=function(...args:any[]){timing.end_called_ms=Date.now();return end.apply(this,args as any);} as typeof response.end;
  response.once('finish',()=>{timing.finish_ms=Date.now();timing.status=response.statusCode;});
  httpContext.run(timing,()=>handlers[0].call(lifecycle.server,request,response));
});
function dump(){writeFileSync(stage+'/evidence/sql-profile-'+process.pid+'.json',JSON.stringify({synthetic_only:true,profile_kind:'writer_roundtrip_including_ipc',pid:process.pid,captured_at:new Date().toISOString(),transactions:total,truncated:total>samples.length,event_loop_ms:{p50:delay.percentile(50)/1e6,p95:delay.percentile(95)/1e6,p99:delay.percentile(99)/1e6,max:delay.max/1e6},checkpoint:lifecycle.checkpointer.status(),samples,http_timings:httpTimings},null,2),{mode:0o600});}
process.on('SIGUSR2',dump);process.once('exit',dump);
console.log(JSON.stringify({diagnostic_profile:true,pid:process.pid,port:3306}));
