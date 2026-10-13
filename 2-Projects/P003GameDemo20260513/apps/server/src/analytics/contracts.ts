import { inspectEventStructure } from './structure.js';
import { createHash } from 'node:crypto';
import { validateProperties } from './event-registry-v1.js';
export const LIMITS={eventBytes:8*1024,bodyBytes:2*1024*1024,events:200,deviceRpm:60,concurrency:2,defaultGlobalRpm:600,diskWarnBytes:8*1024**3,diskStopBytes:4*1024**3} as const;
export type AnalyticsEvent={schema_version:1;client_event_id:string;event_name:string;occurred_at_ms:number;session_id:string;sequence:number;priority:'low'|'normal'|'critical';context:Record<string,unknown>;properties:Record<string,unknown>};
export type AnalyticsBatch={schema_version:1;batch_id:string;sent_at_ms:number;client:Record<string,unknown>;events:unknown[]};
export type RejectReason='event_not_allowed'|'event_too_large'|'invalid_event'|'invalid_context'|'invalid_properties'|'client_event_id_conflict';
export type AnalyticsBatchAck={ok:true;request_id:string;accepted_event_ids:string[];duplicated_event_ids:string[];rejected:{client_event_id:string;reason:RejectReason}[];retry_after_ms:0};
export const isObject=(v:unknown):v is Record<string,unknown>=>typeof v==='object' && v!==null && !Array.isArray(v);
export const onlyKeys=(v:Record<string,unknown>,keys:readonly string[])=>Object.keys(v).every(k=>keys.includes(k));
export const safeIdentifier=(v:unknown,max:number):v is string=>typeof v==='string' && v.length>0 && v.length<=max && /^[A-Za-z0-9_.:-]+$/.test(v) && !/BJP003\d{14}|eyJ[A-Za-z0-9_-]+\.|(?:^|\D)1[3-9]\d{9}(?:$|\D)/.test(v);
export function validRequestId(v:unknown):v is string{return safeIdentifier(v,96);}
const integer=(v:unknown):v is number=>typeof v==='number' && Number.isSafeInteger(v);
const safeString=(v:unknown):v is string=>typeof v==='string' && v.length<=256 && /^[A-Za-z0-9_.:/@+\-]*$/.test(v) && !/BJP003\d{14}|eyJ[A-Za-z0-9_-]+\.|(?:^|\D)1[3-9]\d{9}(?:$|\D)/.test(v);
export function validateAnalyticsBatch(raw:unknown):AnalyticsBatch {
  if(!isObject(raw)||!onlyKeys(raw,['schema_version','batch_id','sent_at_ms','client','events'])||raw.schema_version!==1||!safeIdentifier(raw.batch_id,96)||!integer(raw.sent_at_ms)||!isObject(raw.client)||!onlyKeys(raw.client,['product','component','protocol_version','content_version'])||!Object.values(raw.client).every(safeString)||!Array.isArray(raw.events)||raw.events.length<1||raw.events.length>LIMITS.events||!raw.events.every(e=>isObject(e)&&safeIdentifier(e.client_event_id,128))) throw new Error('INVALID_BATCH');
  return raw as AnalyticsBatch;
}
export function validateAnalyticsEvent(raw:unknown):{ok:true;event:AnalyticsEvent}|{ok:false;reason:RejectReason} {
  const structuralReason=inspectEventStructure(raw);if(structuralReason)return {ok:false,reason:structuralReason};
  if(Buffer.byteLength(JSON.stringify(raw),'utf8')>LIMITS.eventBytes)return {ok:false,reason:'event_too_large'};
  if(!isObject(raw)||!onlyKeys(raw,['schema_version','client_event_id','event_name','occurred_at_ms','session_id','sequence','priority','context','properties'])||raw.schema_version!==1||!safeIdentifier(raw.client_event_id,128)||!safeIdentifier(raw.session_id,64)||typeof raw.event_name!=='string'||raw.event_name.length>96||!integer(raw.occurred_at_ms)||!integer(raw.sequence)||!['low','normal','critical'].includes(raw.priority as string))return {ok:false,reason:'invalid_event'};
  if(!isObject(raw.context)||!onlyKeys(raw.context,['screen','phase','external_screen_connected'])||Object.entries(raw.context).some(([k,v])=>k==='external_screen_connected'?typeof v!=='boolean':!safeString(v)))return {ok:false,reason:'invalid_context'};
  const result=validateProperties(raw.event_name,raw.properties);
  if(result!==null)return {ok:false,reason:result};
  return {ok:true,event:raw as AnalyticsEvent};
}
export function canonicalJson(v:unknown):string{
  if(inspectEventStructure(v))throw new Error('INVALID_EVENT_STRUCTURE');
  return canonicalJsonChecked(v);
}
function canonicalJsonChecked(v:unknown):string{
  if(Array.isArray(v))return '['+v.map(canonicalJsonChecked).join(',')+']';
  if(isObject(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalJsonChecked(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
export const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
