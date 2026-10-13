import {AnalyticsCheckpointer} from './checkpointer.js';
import {ANALYTICS_WAL_MAX_BYTES,validateWalMaxBytes} from './sqlite-policy.mjs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync,lstatSync,statfsSync } from 'node:fs';
import { isAbsolute,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual,createHash } from 'node:crypto';
import { verifyDeviceCredential } from '../device-credential.js';
import { AnalyticsDeviceReader,type AnalyticsDeviceContext } from './device-context.js';
import { AnalyticsStore,AnalyticsStorageUnavailable } from './store.js';
import { LIMITS,validRequestId,validateAnalyticsBatch } from './contracts.js';
import { settleAnalyticsBatch } from './ingest.js';
import { ADMIN_ANALYTICS_PATHS,deviceAlias,queryAnalytics,analyticsQueryFilters } from './admin-query.js';
export function readControl(path:string):{enabled:boolean;valid:boolean}{
  try{
    const stat=lstatSync(path);
    if(!stat.isFile()||stat.size>4096||(stat.mode&0o7777)!==0o600) return {enabled:false,valid:false};
    const data=JSON.parse(readFileSync(path,'utf8'));
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>k!=='enabled')||typeof data.enabled!=='boolean')return {enabled:false,valid:false};
    return {enabled:data.enabled,valid:true};
  }catch(e){return {enabled:false,valid:(e as NodeJS.ErrnoException).code==='ENOENT'};}
}
type Reader={acceptsCredential(subject:string,iat:number):boolean;readAnalyticsDeviceContext(subject:string):AnalyticsDeviceContext;readiness():boolean;readGlobalCollectionConfig?():{event_upload_enabled:boolean;daily_upload_hour_cst:number}};
export type AnalyticsAppOptions={store:AnalyticsStore;reader:Reader;authSecret:string;internalSecret:string;controlPath:string;allowSubjects:readonly string[];globalRpm?:number;diskFreeBytes?:()=>number;walMaxBytes?:number;checkpointStatus?:()=>ReturnType<AnalyticsCheckpointer['status']>};
export function createAnalyticsApp(options:AnalyticsAppOptions){
  if(!isAbsolute(options.controlPath))throw new Error('analytics control path must be absolute');
  const rpm=options.globalRpm??LIMITS.defaultGlobalRpm;if(!Number.isInteger(rpm)||rpm<1||rpm>60000)throw new Error('INVALID_ANALYTICS_GLOBAL_RPM');
  if(options.allowSubjects.length>1000)throw new Error('ANALYTICS_ALLOWLIST_LIMIT');
  const walMax=validateWalMaxBytes(options.walMaxBytes??ANALYTICS_WAL_MAX_BYTES);
  const app=new Hono(),deviceHits=new Map<string,number[]>(),globalHits:number[]=[],durations:number[]=[];
  let inFlight=0,storageFailures=0,sqlBusy=0,requests=0;
  const diskFree=options.diskFreeBytes??(()=>{const info=statfsSync(options.store.path);return Number(info.bavail)*Number(info.bsize);});
  const health=()=>{
    let dependenciesReady=false,storageReady=false,freeBytes:null|number=null;
    try{dependenciesReady=options.reader.readiness();}catch{}
    try{options.store.db.prepare('SELECT count(*) FROM analytics_meta').get();storageReady=true;freeBytes=diskFree();}catch{}
    const control=readControl(options.controlPath),sorted=[...durations].sort((a,b)=>a-b);
    let walBytes=0,walReadable=true;try{walBytes=options.store.walBytes();}catch{walReadable=false;storageReady=false;}
    let meta:{key:string;value:string}[]=[];
    try{meta=options.store.db.prepare('SELECT key,value FROM analytics_meta').all() as {key:string;value:string}[];}catch{storageReady=false;}
    const checkpoint=options.checkpointStatus?.()??null;
    return {ok:true,alive:true,ready:dependenciesReady&&storageReady&&(checkpoint===null||(!checkpoint.stale&&checkpoint.enabled))&&walReadable&&walBytes<walMax&&control.valid&&freeBytes!==null&&freeBytes>=LIMITS.diskStopBytes,dependencies_ready:dependenciesReady,storage_ready:storageReady,gate_enabled:control.enabled,control_valid:control.valid,allowlist_count:options.allowSubjects.length,in_flight:inFlight,requests,storage_failures:storageFailures,sql_busy:sqlBusy,rss_bytes:process.memoryUsage().rss,wal_bytes:walBytes,wal_max_bytes:walMax,wal_pressure:!walReadable||walBytes>=walMax,sqlite_version:options.store.sqliteVersion,sqlite_version_safe:true,sqlite_synchronous:2,sqlite_wal_autocheckpoint:0,checkpoint,disk_free_bytes:freeBytes,disk_warning:freeBytes!==null&&freeBytes<LIMITS.diskWarnBytes,processing_p95_ms:sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]:null,processing_p99_ms:sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.99))]:null,last_rollup_success_ms:Number(meta.find(m=>m.key==='last_rollup_success_ms')?.value)||null,last_rollup_attempt_ms:Number(meta.find(m=>m.key==='last_rollup_attempt_ms')?.value)||null,last_rollup_partial_ms:Number(meta.find(m=>m.key==='last_rollup_partial_ms')?.value)||null,rollup_status:meta.find(m=>m.key==='last_rollup_status')?.value??null,rollup_failed_days:Number(meta.find(m=>m.key==='last_rollup_failed_days')?.value)||0,rollup_remaining_dirty_days:Number(meta.find(m=>m.key==='last_rollup_remaining_dirty_days')?.value)||0,last_backup_success_ms:Number(meta.find(m=>m.key==='last_backup_success_ms')?.value)||null};
  };
  app.get('/health',c=>c.json({ok:true,alive:true}));
  app.get('/ready',c=>{const value=health();return c.json(value,value.ready?200:503);});
  app.use('/internal/analytics/*',async(c,next)=>{
    const token=c.req.header('X-Analytics-Internal-Token');
    const hash=(s:string)=>createHash('sha256').update(s).digest();
    if(!options.internalSecret||!token||!timingSafeEqual(hash(token),hash(options.internalSecret)))return c.json({ok:false,error_code:'UNAUTHORIZED'},401);
    await next();
  });
  for(const kind of ADMIN_ANALYTICS_PATHS)app.get('/internal/analytics/'+kind,c=>{
    if(kind==='health')return c.json(health());
    if(kind==='collection-config')return c.json({ok:true,server_gate:readControl(options.controlPath),allowlist_count:options.allowSubjects.length,global:options.reader.readGlobalCollectionConfig?.()??{event_upload_enabled:false,daily_upload_hour_cst:23},device_defaults:{event_upload_enabled:false,daily_upload_hour_cst:23},items:options.allowSubjects.map(subject=>{const ctx=options.reader.readAnalyticsDeviceContext(subject);return {device_alias:deviceAlias(ctx.deviceKey),active:ctx.active,event_upload_enabled:ctx.uploadEnabled,daily_upload_hour_cst:ctx.uploadHourCst};})});
    const result=queryAnalytics(options.store,kind,new URL(c.req.url).searchParams);
    if(kind==='overview'){result.allowlist_count=options.allowSubjects.length;const allowKeys=options.allowSubjects.map(subject=>options.reader.readAnalyticsDeviceContext(subject).deviceKey);
      const filter=analyticsQueryFilters(new URL(c.req.url).searchParams);
      const covered=allowKeys.length?Number((options.store.db.prepare(`SELECT count(DISTINCT device_key) n FROM analytics_batch WHERE received_at_ms>=? AND received_at_ms<? AND device_key IN (${allowKeys.map(()=>'?').join(',')})${filter.alias?' AND substr(device_key,1,12)=?':''}`).get(Date.parse(filter.from+'T00:00:00Z')-8*3_600_000,Date.parse(filter.to+'T00:00:00Z')+16*3_600_000,...allowKeys,...(filter.alias?[filter.aliasPrefix!]:[])) as {n:number}).n):0;
      result.receiving_allowlisted_devices=covered;result.receiving_coverage=allowKeys.length?covered/allowKeys.length:null;}
    return c.json(result);
  });
  app.post('/v1/device/analytics/events:batch',async c=>{
    const started=performance.now();requests++;
    const error=(code:string,status:400|401|403|413|429|503,retry?:number)=>{if(retry!==undefined)c.header('Retry-After',String(retry));return c.json({ok:false,error_code:code},status);};
    const cred=await verifyDeviceCredential(c.req.header('authorization'),options.authSecret,options.reader.acceptsCredential.bind(options.reader));
    if(!cred)return error('INVALID_DEVICE_CREDENTIAL',401);
    if(!readControl(options.controlPath).enabled)return error('ANALYTICS_UPLOAD_DISABLED',503,900);
    const context=options.reader.readAnalyticsDeviceContext(cred.sn);
    if(!context.active||!options.allowSubjects.includes(cred.sn))return error('ANALYTICS_DEVICE_NOT_ENABLED',403);
    if(!context.uploadEnabled)return error('ANALYTICS_UPLOAD_DISABLED',503,900);
    const requestId=c.req.header('X-Request-Id');if(!validRequestId(requestId))return error('INVALID_REQUEST_ID',400);
    const now=Date.now();while(globalHits.length&&now-globalHits[0]>=60000)globalHits.shift();
    for(const [key,arr] of deviceHits)if(!arr.length||now-arr[arr.length-1]>=60000)deviceHits.delete(key);
    const hits=(deviceHits.get(context.deviceKey)??[]).filter(t=>now-t<60000);
    if(globalHits.length>=rpm||hits.length>=LIMITS.deviceRpm)return error('ANALYTICS_RATE_LIMITED',429,60);
    if(inFlight>=LIMITS.concurrency)return error('ANALYTICS_OVERLOADED',503,5);
    if(options.store.walBytes()>=walMax)return error('ANALYTICS_WAL_PRESSURE',503,10);
    if(diskFree()<LIMITS.diskStopBytes)return error('ANALYTICS_DISK_PRESSURE',503,60);
    if(process.memoryUsage().rss>512*1024**2)return error('ANALYTICS_MEMORY_PRESSURE',503,60);
    globalHits.push(now);hits.push(now);deviceHits.set(context.deviceKey,hits);inFlight++;
    try{
      const length=Number(c.req.header('Content-Length'));
      if(length>LIMITS.bodyBytes)return error('ANALYTICS_BODY_TOO_LARGE',413);
      const stream=c.req.raw.body;if(!stream)return error('INVALID_BATCH',400);
      const reader=stream.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>LIMITS.bodyBytes){await reader.cancel();return error('ANALYTICS_BODY_TOO_LARGE',413);}chunks.push(value);}
      let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return error('INVALID_JSON',400);}
      let batch;try{batch=validateAnalyticsBatch(raw);}catch{return error('INVALID_BATCH',400);}
      if(!readControl(options.controlPath).enabled)return error('ANALYTICS_UPLOAD_DISABLED',503,900);
      const latestContext=options.reader.readAnalyticsDeviceContext(cred.sn);
      if(!latestContext.active)return error('ANALYTICS_DEVICE_NOT_ENABLED',403);
      if(!latestContext.uploadEnabled)return error('ANALYTICS_UPLOAD_DISABLED',503,900);
      if(options.store.walBytes()>=walMax)return error('ANALYTICS_WAL_PRESSURE',503,10);
      const ack=settleAnalyticsBatch(options.store,latestContext,batch,requestId);return c.json(ack);
    }catch(cause){storageFailures++;if(cause instanceof AnalyticsStorageUnavailable&&cause.busy)sqlBusy++;return error('ANALYTICS_STORAGE_UNAVAILABLE',503,30);}
    finally{inFlight--;durations.push(Math.ceil(performance.now()-started));if(durations.length>1024)durations.shift();}
  });
  app.onError((e,c)=>{const invalid=e.message==='INVALID_QUERY';console.error('[analytics] '+(invalid?'INVALID_QUERY':'DEPENDENCY_UNAVAILABLE'));c.header('Retry-After','30');return c.json({ok:false,error_code:invalid?'INVALID_QUERY':'ANALYTICS_DEPENDENCY_UNAVAILABLE'},invalid?400:503);});
  return app;
}
export function analyticsOptionsFromEnv():AnalyticsAppOptions{
  const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error('MISSING_'+key);return value;};
  const devicesPath=required('ANALYTICS_DEVICES_DB_PATH'),configPath=required('ANALYTICS_CONFIG_DB_PATH');
  const allow=(process.env.ANALYTICS_SN_ALLOW??'').split(',').map(s=>s.trim()).filter(Boolean);
  return {store:new AnalyticsStore(required('ANALYTICS_DB_PATH')),reader:new AnalyticsDeviceReader({devicesPath,configPath,deviceKeySecret:required('ANALYTICS_DEVICE_KEY_SECRET'),envAllow:(process.env.DEVICE_SN_ALLOW??'').split(',').map(s=>s.trim()).filter(Boolean)}),authSecret:required('AUTH_JWT_SECRET'),internalSecret:required('ANALYTICS_INTERNAL_SECRET'),controlPath:required('ANALYTICS_CONTROL_PATH'),allowSubjects:allow,walMaxBytes:Number(process.env.ANALYTICS_WAL_MAX_BYTES??ANALYTICS_WAL_MAX_BYTES),globalRpm:Number(process.env.ANALYTICS_GLOBAL_RPM??600)};
}
/** One lifecycle for production (3006) and the explicitly isolated staging listener (3306). */
export function startAnalyticsServer(options:AnalyticsAppOptions,port:3006|3306=3006){
  if(port!==3006&&port!==3306)throw new Error('INVALID_ANALYTICS_LISTEN_PORT');
  const checkpointer=new AnalyticsCheckpointer(options.store.path,{walMaxBytes:options.walMaxBytes,nodePath:process.env.ANALYTICS_NODE_PATH??process.execPath});
  options.checkpointStatus=()=>checkpointer.status();
  const app=createAnalyticsApp(options);
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port});checkpointer.start();
  let stopped:Promise<void>|undefined;
  const signal=()=>{void stop().then(()=>process.exit(0));};
  function stop(){
    if(stopped)return stopped;
    stopped=(async()=>{process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);server.close();if('closeAllConnections' in server)server.closeAllConnections();await checkpointer.stop();options.store.close();})();
    return stopped;
  }
  process.once('SIGTERM',signal);process.once('SIGINT',signal);
  return {server,checkpointer,stop};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let options:AnalyticsAppOptions|undefined;
  try{options=analyticsOptionsFromEnv();startAnalyticsServer(options);console.log('[analytics] LISTENING_3006');}
  catch{options?.store.close();console.error('[analytics] STARTUP_CONFIGURATION_ERROR');process.exitCode=1;}
}
