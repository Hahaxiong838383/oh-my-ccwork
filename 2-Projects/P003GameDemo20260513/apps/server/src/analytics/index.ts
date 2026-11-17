import {capacityReader} from './capacity.js';
import {readAnalyticsBody,AnalyticsBodyError} from './http-body.js';
import {queryAnalyticsTiers} from './tier-query.js';
import type {UploadPolicy} from './upload-policy.js';
import {readBoundedJson} from '../ark/http.js';
import {readArkHistory} from '../ark/history.js';
import {createObservationGateway} from './observations-route.js';
import {historyRequestSchema} from '../ark/contracts.js';
import type {ArkIdentity} from '../ark/identity.js';
import {AnalyticsCheckpointer} from './checkpointer.js';
import {ANALYTICS_WAL_MAX_BYTES,validateWalMaxBytes} from './sqlite-policy.mjs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync,lstatSync,statfsSync } from 'node:fs';
import { isAbsolute,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual,createHash } from 'node:crypto';
import { verifyDeviceCredential,type DeviceCredentialStateReader } from '../device-credential.js';
import { AnalyticsDeviceReader,type AnalyticsDeviceContext } from './device-context.js';
import { AnalyticsStore,AnalyticsStorageUnavailable } from './store.js';
import { LIMITS,validRequestId,validateAnalyticsBatch } from './contracts.js';
import { settleAnalyticsBatch } from './ingest.js';
import { AnalyticsWriter,AnalyticsWriterBusy } from './writer.js';
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
type Reader={uploadPolicy?():UploadPolicy|null;arkDeviceKey?(subject:string):string;readArkAuthorization?(subject:string):(ArkIdentity&{not_before_ms:number})|null;acceptsCredential(subject:string,iat:number):boolean;readCredentialState:DeviceCredentialStateReader;readAnalyticsDeviceContext(subject:string):AnalyticsDeviceContext;readiness():boolean;readGlobalCollectionConfig?():{event_upload_enabled:boolean;daily_upload_hour_cst:number}};
export type AnalyticsAppOptions={store:AnalyticsStore;writer?:Pick<AnalyticsWriter,'ready'|'busy'|'settle'|'close'>;reader:Reader;authSecret:string;internalSecret:string;controlPath:string;allowSubjects:readonly string[];globalRpm?:number;diskFreeBytes?:()=>number;walMaxBytes?:number;bodyTimeoutMs?:number;checkpointStatus?:()=>ReturnType<AnalyticsCheckpointer['status']>};
export function createAnalyticsApp(options:AnalyticsAppOptions){
  if(!isAbsolute(options.controlPath))throw new Error('analytics control path must be absolute');
  const rpm=options.globalRpm??LIMITS.defaultGlobalRpm;if(!Number.isInteger(rpm)||rpm<1||rpm>60000)throw new Error('INVALID_ANALYTICS_GLOBAL_RPM');
  if(options.allowSubjects.length>1000)throw new Error('ANALYTICS_ALLOWLIST_LIMIT');
  const walMax=validateWalMaxBytes(options.walMaxBytes??ANALYTICS_WAL_MAX_BYTES);
  const app=new Hono(),deviceHits=new Map<string,number[]>(),globalHits:number[]=[],durations:number[]=[];
  let inFlight=0,storageFailures=0,sqlBusy=0,requests=0;
  const diskFree=options.diskFreeBytes??(()=>{const info=statfsSync(options.store.path);return Number(info.bavail)*Number(info.bsize);});
  const capacity=capacityReader(options.store);
  const admission=()=>{
    const emergency=readControl(options.controlPath);
    try{const policy=options.reader.uploadPolicy?.()??null;return {valid:emergency.valid,enabled:emergency.enabled&&(policy?.enabled??true),subjects:policy?.subjects??options.allowSubjects,policy,emergency};}
    catch{return {valid:false,enabled:false,subjects:[] as readonly string[],policy:null,emergency};}
  };
  const health=()=>{
    let dependenciesReady=false,storageReady=false,freeBytes:null|number=null;
    try{dependenciesReady=options.reader.readiness();}catch{}
    try{options.store.db.prepare('SELECT count(*) FROM analytics_meta').get();storageReady=true;freeBytes=diskFree();}catch{}
    const control=admission(),sorted=[...durations].sort((a,b)=>a-b);
    let walBytes=0,walReadable=true;try{walBytes=options.store.walBytes();}catch{walReadable=false;storageReady=false;}
    let meta:{key:string;value:string}[]=[];
    try{meta=options.store.db.prepare('SELECT key,value FROM analytics_meta').all() as {key:string;value:string}[];}catch{storageReady=false;}
    const checkpoint=options.checkpointStatus?.()??null;
    if(options.writer&&!options.writer.ready)storageReady=false;
    return {ok:true,alive:true,ready:dependenciesReady&&storageReady&&(checkpoint===null||(!checkpoint.stale&&checkpoint.enabled))&&walReadable&&walBytes<walMax&&control.valid&&freeBytes!==null&&freeBytes>=LIMITS.diskStopBytes,dependencies_ready:dependenciesReady,storage_ready:storageReady,gate_enabled:control.enabled,control_valid:control.valid,allowlist_count:control.subjects.length,in_flight:inFlight,requests,storage_failures:storageFailures,sql_busy:sqlBusy,rss_bytes:process.memoryUsage().rss,wal_bytes:walBytes,wal_max_bytes:walMax,wal_pressure:!walReadable||walBytes>=walMax,sqlite_version:options.store.sqliteVersion,sqlite_version_safe:true,sqlite_synchronous:2,sqlite_wal_autocheckpoint:0,checkpoint,disk_free_bytes:freeBytes,disk_warning:freeBytes!==null&&freeBytes<LIMITS.diskWarnBytes,processing_p95_ms:sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]:null,processing_p99_ms:sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.99))]:null,last_rollup_success_ms:Number(meta.find(m=>m.key==='last_rollup_success_ms')?.value)||null,last_rollup_attempt_ms:Number(meta.find(m=>m.key==='last_rollup_attempt_ms')?.value)||null,last_rollup_partial_ms:Number(meta.find(m=>m.key==='last_rollup_partial_ms')?.value)||null,rollup_status:meta.find(m=>m.key==='last_rollup_status')?.value??null,rollup_failed_days:Number(meta.find(m=>m.key==='last_rollup_failed_days')?.value)||0,rollup_remaining_dirty_days:Number(meta.find(m=>m.key==='last_rollup_remaining_dirty_days')?.value)||0,last_backup_success_ms:Number(meta.find(m=>m.key==='last_backup_success_ms')?.value)||null};
  };
  app.get('/health',c=>c.json({ok:true,alive:true}));
  app.get('/ready',c=>{const value=health();return c.json(value,value.ready?200:503);});
  app.use('/internal/analytics/*',async(c,next)=>{
    const token=c.req.header('X-Analytics-Internal-Token');
    const hash=(s:string)=>createHash('sha256').update(s).digest();
    if(!options.internalSecret||!token||!timingSafeEqual(hash(token),hash(options.internalSecret)))return c.json({ok:false,error_code:'UNAUTHORIZED'},401);
    await next();
  });
  app.route('/',createObservationGateway({db:options.store.db,deviceKey:sn=>options.reader.arkDeviceKey?.(sn)??'',internalSecret:options.internalSecret,cursorSecret:options.authSecret}));
  app.post('/internal/analytics/ark-summary',async c=>{
    // Independent read-only capability; never turns on the batch upload gate.
    let body:unknown;try{body=await readBoundedJson(c.req.raw,1024);}catch(e){return c.json({ok:false,error_code:'INVALID_QUERY'},(e as {status?:number}).status===413?413:400);}
    const parsed=historyRequestSchema.safeParse(body);if(!parsed.success)return c.json({ok:false,error_code:'INVALID_QUERY'},400);
    const q=parsed.data,identity=options.reader.readArkAuthorization?.(q.subject);
    if(!identity||identity.account_id!==q.account_id||identity.epoch!==q.epoch||q.not_before_ms<identity.not_before_ms)return c.json({ok:false,error_code:'ARK_NOT_AUTHORIZED'},403);
    const key=options.reader.arkDeviceKey?.(q.subject);if(!key)return c.json({ok:false,error_code:'ARK_NOT_AUTHORIZED'},403);
    c.header('Cache-Control','no-store');
    return c.json(readArkHistory(options.store,key,q.not_before_ms));
  });
  app.get('/internal/analytics/upload-status',c=>{const a=admission();return c.json({ok:true,revision:a.policy?.revision??0,enabled:a.policy?.enabled??a.emergency.enabled,subjects:a.subjects,hour:a.policy?.hour??23,effective_enabled:a.enabled,valid:a.valid,emergency_gate:a.emergency,managed:!!a.policy,device_config:a.subjects.map(sn=>{const d=options.reader.readAnalyticsDeviceContext(sn);return {sn,active:d.active,enabled:d.uploadEnabled,hour:d.uploadHourCst};})});});
  app.get('/internal/analytics/capacity',c=>c.json(capacity()));
  app.get('/internal/analytics/tiering',c=>{
    const sn=c.req.query('sn');if(!sn||sn.length>64)return c.json({ok:false,error_code:'INVALID_QUERY'},400);
    const context=options.reader.readAnalyticsDeviceContext(sn),a=admission(),h=health();
    return c.json({...queryAnalyticsTiers(options.store,context.deviceKey),runtime_ready:h.ready,upload_allowed:a.valid&&a.enabled&&context.active&&context.uploadEnabled&&a.subjects.includes(sn),capabilities:{version:1,gzip:true,wire_limit_bytes:LIMITS.bodyBytes,inflated_limit_bytes:LIMITS.bodyBytes,aggregate_period_days:7}});
  });
  for(const kind of ADMIN_ANALYTICS_PATHS)app.get('/internal/analytics/'+kind,c=>{
    if(kind==='health')return c.json(health());
    if(kind==='collection-config'){const control=admission();return c.json({ok:true,server_gate:{enabled:control.enabled,valid:control.valid},allowlist_count:control.subjects.length,global:options.reader.readGlobalCollectionConfig?.()??{event_upload_enabled:false,daily_upload_hour_cst:23},device_defaults:{event_upload_enabled:false,daily_upload_hour_cst:23},items:control.subjects.map(subject=>{const ctx=options.reader.readAnalyticsDeviceContext(subject);return {device_alias:deviceAlias(ctx.deviceKey),active:ctx.active,event_upload_enabled:ctx.uploadEnabled,daily_upload_hour_cst:ctx.uploadHourCst};})});}
    const readResult=()=>{const result=queryAnalytics(options.store,kind,new URL(c.req.url).searchParams);
    if(kind==='overview'){const subjects=admission().subjects;result.allowlist_count=subjects.length;const allowKeys=subjects.map(subject=>options.reader.readAnalyticsDeviceContext(subject).deviceKey);
      const filter=analyticsQueryFilters(new URL(c.req.url).searchParams);
      const covered=allowKeys.length?Number((options.store.db.prepare(`SELECT count(DISTINCT device_key) n FROM analytics_batch WHERE received_at_ms>=? AND received_at_ms<? AND device_key IN (${allowKeys.map(()=>'?').join(',')})${filter.alias?' AND substr(device_key,1,12)=?':''}`).get(Date.parse(filter.from+'T00:00:00Z')-8*3_600_000,Date.parse(filter.to+'T00:00:00Z')+16*3_600_000,...allowKeys,...(filter.alias?[filter.aliasPrefix!]:[])) as {n:number}).n):0;
      result.receiving_allowlisted_devices=covered;result.receiving_coverage=allowKeys.length?covered/allowKeys.length:null;}
    return result;};
    return c.json(kind==='overview'?options.store.readSnapshot(readResult):readResult());
  });
  app.post('/v1/device/analytics/events:batch',async c=>{
    const started=performance.now();requests++;
    const error=(code:string,status:400|401|403|413|415|429|503,retry?:number)=>{if(retry!==undefined)c.header('Retry-After',String(retry));return c.json({ok:false,error_code:code},status);};
    if(typeof options.reader.readCredentialState!=='function')return error('ANALYTICS_DEPENDENCY_UNAVAILABLE',503,30);
    const cred=await verifyDeviceCredential(c.req.header('authorization'),options.authSecret,options.reader.acceptsCredential.bind(options.reader),options.reader.readCredentialState.bind(options.reader));
    if(!cred)return error('INVALID_DEVICE_CREDENTIAL',401);
    const context=options.reader.readAnalyticsDeviceContext(cred.sn),initial=admission();
    if(!initial.enabled||!initial.valid)return error('ANALYTICS_UPLOAD_DISABLED',503,900);
    if(!context.active||!initial.subjects.includes(cred.sn))return error('ANALYTICS_DEVICE_NOT_ENABLED',403);
    if(!context.uploadEnabled)return error('ANALYTICS_UPLOAD_DISABLED',503,900);
    const requestId=c.req.header('X-Request-Id');if(!validRequestId(requestId))return error('INVALID_REQUEST_ID',400);
    const now=Date.now();while(globalHits.length&&now-globalHits[0]>=60000)globalHits.shift();
    for(const [key,arr] of deviceHits)if(!arr.length||now-arr[arr.length-1]>=60000)deviceHits.delete(key);
    const hits=(deviceHits.get(context.deviceKey)??[]).filter(t=>now-t<60000);
    if(globalHits.length>=rpm||hits.length>=LIMITS.deviceRpm)return error('ANALYTICS_RATE_LIMITED',429,60);
    if(options.writer&&!options.writer.ready)return error('ANALYTICS_STORAGE_UNAVAILABLE',503,30);
    if(options.writer?.busy)return error('ANALYTICS_OVERLOADED',503,5);
    if(inFlight>=LIMITS.concurrency)return error('ANALYTICS_OVERLOADED',503,5);
    if(options.store.walBytes()>=walMax)return error('ANALYTICS_WAL_PRESSURE',503,10);
    if(diskFree()<LIMITS.diskStopBytes)return error('ANALYTICS_DISK_PRESSURE',503,60);
    if(process.memoryUsage().rss>512*1024**2)return error('ANALYTICS_MEMORY_PRESSURE',503,60);
    globalHits.push(now);hits.push(now);deviceHits.set(context.deviceKey,hits);inFlight++;
    try{
      const transport=await readAnalyticsBody(c.req.raw,options.bodyTimeoutMs);
      const rawBody=transport.text;
      let raw:unknown;try{raw=JSON.parse(rawBody);}catch{return error('INVALID_JSON',400);}
      let batch;try{batch=validateAnalyticsBatch(raw);}catch{return error('INVALID_BATCH',400);}
      const latestContext=options.reader.readAnalyticsDeviceContext(cred.sn),latestAdmission=admission();
      if(!latestAdmission.enabled||!latestAdmission.valid)return error('ANALYTICS_UPLOAD_DISABLED',503,900);
      if(!latestContext.active||!latestAdmission.subjects.includes(cred.sn))return error('ANALYTICS_DEVICE_NOT_ENABLED',403);
      if(!latestContext.uploadEnabled)return error('ANALYTICS_UPLOAD_DISABLED',503,900);
      if(options.store.walBytes()>=walMax)return error('ANALYTICS_WAL_PRESSURE',503,10);
      if(options.writer&&!options.writer.ready)return error('ANALYTICS_STORAGE_UNAVAILABLE',503,30);
      if(options.writer?.busy)return error('ANALYTICS_OVERLOADED',503,5);
      // Transfer the original JSON text: structuredClone can overflow on a deeply invalid event
      // before the worker can settle it as a per-event rejection alongside valid events.
      const measured={encoding:transport.encoding,wireBytes:transport.wireBytes,inflatedBytes:transport.inflatedBytes};
      const ack=options.writer?await options.writer.settle(latestContext,batch,requestId,rawBody,measured):settleAnalyticsBatch(options.store,latestContext,batch,requestId,Date.now(),measured);return c.json(ack);
    }catch(cause){if(cause instanceof AnalyticsBodyError)return error(cause.code,cause.status,cause.status===503?5:undefined);if(cause instanceof AnalyticsWriterBusy)return error('ANALYTICS_OVERLOADED',503,5);storageFailures++;if(cause instanceof AnalyticsStorageUnavailable&&cause.busy)sqlBusy++;return error('ANALYTICS_STORAGE_UNAVAILABLE',503,30);}
    finally{inFlight--;durations.push(Math.ceil(performance.now()-started));if(durations.length>1024)durations.shift();}
  });
  app.onError((e,c)=>{const invalid=e.message==='INVALID_QUERY';console.error('[analytics] '+(invalid?'INVALID_QUERY':'DEPENDENCY_UNAVAILABLE'));c.header('Retry-After','30');return c.json({ok:false,error_code:invalid?'INVALID_QUERY':'ANALYTICS_DEPENDENCY_UNAVAILABLE'},invalid?400:503);});
  return app;
}
export function analyticsOptionsFromEnv():AnalyticsAppOptions{
  const required=(key:string)=>{const value=process.env[key];if(!value)throw new Error('MISSING_'+key);return value;};
  const devicesPath=required('ANALYTICS_DEVICES_DB_PATH'),configPath=required('ANALYTICS_CONFIG_DB_PATH');
  const allow=(process.env.ANALYTICS_SN_ALLOW??'').split(',').map(s=>s.trim()).filter(Boolean);
  return {store:new AnalyticsStore(required('ANALYTICS_DB_PATH')),reader:new AnalyticsDeviceReader({devicesPath,configPath,arkPath:process.env.ARK_DB_PATH?resolve(process.env.ARK_DB_PATH):undefined,deviceKeySecret:required('ANALYTICS_DEVICE_KEY_SECRET'),envAllow:(process.env.DEVICE_SN_ALLOW??'').split(',').map(s=>s.trim()).filter(Boolean)}),authSecret:required('AUTH_JWT_SECRET'),internalSecret:required('ANALYTICS_INTERNAL_SECRET'),controlPath:required('ANALYTICS_CONTROL_PATH'),allowSubjects:allow,walMaxBytes:Number(process.env.ANALYTICS_WAL_MAX_BYTES??ANALYTICS_WAL_MAX_BYTES),globalRpm:Number(process.env.ANALYTICS_GLOBAL_RPM??600)};
}
/** One lifecycle for production (3006) and the explicitly isolated staging listener (3306). */
export function startAnalyticsServer(options:AnalyticsAppOptions,port:3006|3306=3006){
  if(port!==3006&&port!==3306)throw new Error('INVALID_ANALYTICS_LISTEN_PORT');
  const configuredInterval=process.env.ANALYTICS_CHECKPOINT_INTERVAL_MS;
  if(configuredInterval!==undefined&&(!/^\d+$/.test(configuredInterval)||Number(configuredInterval)<100||Number(configuredInterval)>10000))throw new Error('INVALID_ANALYTICS_CHECKPOINT_INTERVAL_MS');
  const checkpointer=new AnalyticsCheckpointer(options.store.path,{walMaxBytes:options.walMaxBytes,nodePath:process.env.ANALYTICS_NODE_PATH??process.execPath,intervalMs:configuredInterval===undefined?10000:Number(configuredInterval)});
  options.checkpointStatus=()=>checkpointer.status();
  // Validate configuration before creating a thread that would outlive a failed startup.
  const app=createAnalyticsApp(options);
  // The HTTP connection is for queries only. Blocking SQLite transactions live in one worker.
  options.store.db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA shrink_memory');
  const writer=options.writer??new AnalyticsWriter(options.store.path);options.writer=writer;
  let server!:ReturnType<typeof serve>;
  try{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port});checkpointer.start();}
  catch(error){server?.close();void writer.close().catch(()=>{});void checkpointer.stop().catch(()=>{});throw error;}
  let stopped:Promise<void>|undefined;
  const signal=()=>{void stop().then(()=>process.exit(0),()=>{console.error('[analytics] SHUTDOWN_STORAGE_UNAVAILABLE');process.exit(1);});};
  function stop(){
    if(stopped)return stopped;
    stopped=(async()=>{process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);server.close();try{await writer.close();}finally{if('closeAllConnections' in server)server.closeAllConnections();await checkpointer.stop();options.store.close();}})();
    return stopped;
  }
  process.once('SIGTERM',signal);process.once('SIGINT',signal);
  return {server,checkpointer,writer,stop};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let options:AnalyticsAppOptions|undefined;
  try{options=analyticsOptionsFromEnv();startAnalyticsServer(options);console.log('[analytics] LISTENING_3006');}
  catch{options?.store.close();console.error('[analytics] STARTUP_CONFIGURATION_ERROR');process.exitCode=1;}
}
