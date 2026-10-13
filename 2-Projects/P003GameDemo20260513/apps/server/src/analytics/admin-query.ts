import { Hono } from 'hono';
import { AnalyticsStore,DAY_MS,cstDay } from './store.js';
import { digest } from './contracts.js';
import { EVENT_REGISTRY } from './event-registry-v1.js';
export const ADMIN_ANALYTICS_PATHS=['overview','daily','batches','events','registry','health','collection-config'] as const;
export const deviceAlias=(key:string)=>'设备-'+key.slice(0,12);
const page=(params:URLSearchParams)=>({limit:Math.max(1,Math.min(100,Math.floor(Number(params.get('limit')))||50)),offset:Math.max(0,Math.min(10000,Math.floor(Number(params.get('offset')))||0))});
export function analyticsQueryFilters(params:URLSearchParams,now=Date.now(),defaultDays=14){
  const dimension=params.get('dimension')??'occurred';
  if(!['occurred','received'].includes(dimension))throw new Error('INVALID_QUERY');
  const from=params.get('from')||cstDay(now-(defaultDays-1)*DAY_MS),to=params.get('to')||cstDay(now);
  const dayMs=(value:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('INVALID_QUERY');const ms=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==value)throw new Error('INVALID_QUERY');return ms;};
  const range=dayMs(to)-dayMs(from);if(range<0||range>89*DAY_MS)throw new Error('INVALID_QUERY');
  const alias=params.get('device_alias');if(alias&&!/^设备-[a-f0-9]{12}$/.test(alias))throw new Error('INVALID_QUERY');
  return {dimension,from,to,alias,aliasPrefix:alias?.slice(3),days:Math.round(range/DAY_MS)+1};
}
export function queryAnalytics(store:AnalyticsStore,kind:string,params:URLSearchParams,now=Date.now()):any{
  const {limit,offset}=page(params),db=store.db;
  if(kind==='registry')return {ok:true,schema_version:1,event_count:EVENT_REGISTRY.length,items:EVENT_REGISTRY.map(e=>({event_name:e.eventName,group:e.group,properties_schema:e.jsonSchema}))};
  const filter=analyticsQueryFilters(params,now,kind==='daily'?90:14);
  const aliasSql=filter.alias?' AND substr(device_key,1,12)=?':'';
  const bindings=[filter.from,filter.to,...(filter.alias?[filter.aliasPrefix!]:[])];
  if(kind==='overview'){
    return store.readSnapshot(()=>{
    // At most daily/device-daily aggregate rows; never scan one row per accepted event here.
    const table=filter.alias?'analytics_device_day':'analytics_day';
    const aggregate=(dimension:string)=>db.prepare(`SELECT coalesce(sum(json_extract(summary_json,'$.event_count')),0) event_count,max(json_extract(summary_json,'$.data_cutoff_ms')) last_received_at_ms,coalesce(sum(json_extract(summary_json,'$.clock_suspicious_events')),0) clock_suspicious_events,count(DISTINCT day) summary_days,max(${filter.alias?"json_extract(summary_json,'$.updated_at_ms')":'updated_at_ms'}) updated_at_ms FROM ${table} WHERE dimension=? AND day>=? AND day<=?${aliasSql}`).get(dimension,...bindings) as {event_count:number;last_received_at_ms:number|null;clock_suspicious_events:number;summary_days:number;updated_at_ms:number|null};
    const events=aggregate(filter.dimension),clock=filter.dimension==='received'?events:aggregate('received');
    const active=db.prepare(`SELECT count(DISTINCT device_key) n FROM analytics_device_day WHERE dimension=? AND day>=? AND day<=?${aliasSql}`).get(filter.dimension,...bindings) as {n:number};
    // Dirty is per whole day; conservatively report a device view incomplete when that day is dirty.
    const dirty=(dimension:string)=>Number((db.prepare('SELECT count(*) n FROM analytics_dirty_day WHERE dimension=? AND day>=? AND day<=?').get(dimension,filter.from,filter.to) as {n:number}).n);
    const dirtyDays=dirty(filter.dimension),clockDirty=filter.dimension==='received'?dirtyDays:dirty('received');
    const receiptWhere=` WHERE received_at_ms>=? AND received_at_ms<?${aliasSql}`;
    const receiptBindings=[Date.parse(filter.from+'T00:00:00Z')-8*3_600_000,Date.parse(filter.to+'T00:00:00Z')+16*3_600_000,...(filter.alias?[filter.aliasPrefix!]:[])];
    const batches=db.prepare('SELECT count(*) batches,coalesce(sum(accepted),0) accepted,coalesce(sum(duplicated),0) duplicated,coalesce(sum(rejected),0) rejected,max(received_at_ms) last_batch_received_at_ms FROM analytics_batch'+receiptWhere).get(...receiptBindings);
    const covered=db.prepare('SELECT count(DISTINCT device_key) n FROM analytics_batch'+receiptWhere).get(...receiptBindings) as {n:number};
    const devices=db.prepare(`SELECT DISTINCT device_key FROM analytics_device_day WHERE dimension=? AND day>=? AND day<=? ORDER BY device_key LIMIT 1000`).all(filter.dimension,filter.from,filter.to) as {device_key:string}[];
    return {ok:true,window_days:filter.days,from:filter.from,to:filter.to,dimension:filter.dimension,device_alias:filter.alias??null,batch_dimension:'received',data_cutoff_ms:events.last_received_at_ms,event_count:events.event_count,active_devices:active.n,last_received_at_ms:events.last_received_at_ms,clock_suspicious_events:clock.clock_suspicious_events,receiving_devices:covered.n,...batches,rollup:{complete:dirtyDays===0&&clockDirty===0,dirty_days:dirtyDays,clock_dirty_days:clockDirty,summary_days:events.summary_days,clock_summary_days:clock.summary_days,updated_at_ms:events.updated_at_ms,data_cutoff_ms:events.last_received_at_ms,clock_data_cutoff_ms:clock.last_received_at_ms},client_pending_known:false,devices:devices.map(d=>({device_alias:deviceAlias(d.device_key)}))};
    });
  }
  if(kind==='daily'){
    const table=filter.alias?'analytics_device_day':'analytics_day';
    const rows=db.prepare(`SELECT day,summary_json${filter.alias?'':',updated_at_ms'} FROM ${table} WHERE dimension=? AND day>=? AND day<=?${aliasSql} ORDER BY day DESC LIMIT ? OFFSET ?`).all(filter.dimension,...bindings,limit,offset) as {day:string;summary_json:string;updated_at_ms?:number}[];
    return {ok:true,dimension:filter.dimension,from:filter.from,to:filter.to,device_alias:filter.alias??null,limit,offset,items:rows.map(r=>{const summary=JSON.parse(r.summary_json);return {day:r.day,...summary,updated_at_ms:r.updated_at_ms??summary.updated_at_ms??null};})};
  }
  if(kind==='batches'){
    const requestId=params.get('request_id');if(requestId&&requestId.length>96)throw new Error('INVALID_QUERY');
    const where=`WHERE received_at_ms>=? AND received_at_ms<?${aliasSql}${requestId?' AND request_id=?':''}`;
    const values=[Date.parse(filter.from+'T00:00:00Z')-8*3_600_000,Date.parse(filter.to+'T00:00:00Z')+16*3_600_000,...(filter.alias?[filter.aliasPrefix!]:[]),...(requestId?[requestId]:[]),limit,offset];
    const rows=db.prepare(`SELECT * FROM analytics_batch ${where} ORDER BY received_at_ms DESC,attempt_id LIMIT ? OFFSET ?`).all(...values) as any[];
    return {ok:true,dimension:'received',from:filter.from,to:filter.to,device_alias:filter.alias??null,limit,offset,items:rows.map(({device_key,client_json,...row})=>({...row,device_alias:deviceAlias(device_key),upload_client:JSON.parse(client_json),sent_received_skew_ms:row.received_at_ms-row.sent_at_ms}))};
  }
  if(kind==='events'){
    const id=params.get('client_event_id');if(!id||id.length>128)throw new Error('INVALID_QUERY');
    const idHash=digest(id),receiptAlias=filter.alias?' AND substr(b.device_key,1,12)=?':'';
    const receiptBindings=[Date.parse(filter.from+'T00:00:00Z')-8*3_600_000,Date.parse(filter.to+'T00:00:00Z')+16*3_600_000,...(filter.alias?[filter.aliasPrefix!]:[])];
    const rows=db.prepare(`SELECT s.attempt_id,s.outcome,s.reason,b.request_id,b.received_at_ms,b.device_key FROM analytics_settlement s JOIN analytics_batch b ON b.attempt_id=s.attempt_id WHERE s.id_digest=? AND b.received_at_ms>=? AND b.received_at_ms<?${receiptAlias} ORDER BY b.received_at_ms DESC LIMIT ? OFFSET ?`).all(idHash,...receiptBindings,limit,offset) as any[];
    const dayColumn=filter.dimension==='received'?'received_day':'occurred_day';
    const events=db.prepare(`SELECT device_key,event_name,occurred_at_ms,received_at_ms,session_id,sequence,priority,clock_suspicious FROM analytics_event WHERE client_event_id=? AND ${dayColumn}>=? AND ${dayColumn}<=?${aliasSql} ORDER BY received_at_ms DESC LIMIT ? OFFSET ?`).all(id,...bindings,limit,offset) as any[];
    return {ok:true,id_digest:idHash,from:filter.from,to:filter.to,dimension:filter.dimension,device_alias:filter.alias??null,limit,offset,settlements:rows.map(({device_key,...r})=>({...r,device_alias:deviceAlias(device_key)})),events:events.map(({device_key,session_id,...r})=>({...r,device_alias:deviceAlias(device_key),session_digest:digest(session_id)}))};
  }
  throw new Error('INVALID_QUERY');
}
export function analyticsAdminGateway(options:{authorize:(header:string|undefined)=>string;internalUrl:string;internalSecret:string;fetchImpl?:typeof fetch}){
  const route=new Hono();
  route.use('*',async(c,next)=>{
    const role=options.authorize(c.req.header('authorization'));
    if(role==='none')return c.json({ok:false,error:'unauthorized'},401);
    if(role!=='admin')return c.json({ok:false,error:'forbidden_analytics'},403);
    await next();
  });
  for(const kind of ADMIN_ANALYTICS_PATHS)route.get('/'+kind,async c=>{
    try{
      if(!options.internalSecret)throw new Error('UNAVAILABLE');
      const origin=new URL(options.internalUrl);
      if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password)throw new Error('UNAVAILABLE');
      const url=new URL('/internal/analytics/'+kind,origin);url.search=new URL(c.req.url).search;
      const response=await (options.fetchImpl??fetch)(url,{headers:{'X-Analytics-Internal-Token':options.internalSecret},signal:AbortSignal.timeout(2000),redirect:'error'});
      if(!response.body)throw new Error('UNAVAILABLE');
      const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
      while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>512*1024){await reader.cancel();throw new Error('UNAVAILABLE');}chunks.push(value);}
      const body=Buffer.concat(chunks);JSON.parse(body.toString('utf8'));
      return new Response(body,{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    }catch{return c.json({ok:false,error:'analytics_unavailable'},503);}
  });
  return route;
}
