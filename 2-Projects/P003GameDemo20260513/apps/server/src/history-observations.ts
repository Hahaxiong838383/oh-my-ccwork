import type {DatabaseSync} from 'node:sqlite';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
export class ObservationError extends Error{constructor(public status:400|404|410|503,message:string){super(message);}}
export const observationKinds=['rewards','inventory','makeup_cards','progress','wallet'] as const;
export type ObservationKind=typeof observationKinds[number];
const names:Record<string,ObservationKind>={'g1.reward_granted':'rewards','g1.inventory_changed':'inventory','g1.makeup_card_balance_changed':'makeup_cards','g1.progress_checkpoint':'progress','g1.wallet_balance_changed':'wallet'};
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const n=Date.parse(s+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s;});
export const ObservationQuerySchema=z.object({kind:z.enum(['all',...observationKinds]).default('all'),limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().min(1).max(4096).optional(),from_day:date.optional(),to_day:date.optional()}).strict().refine(q=>!q.from_day||!q.to_day||q.from_day<=q.to_day);
export type ObservationQuery=z.input<typeof ObservationQuerySchema>;
export type Observation={event_id:string;event_name:string;kind:ObservationKind;occurred_at_ms:number;received_at_ms:number;logical_day:string|null;time_status:'reported'|'clock_suspect';source_mode:'unknown';rewards?:{item_id:string;kind:string;quantity:number|null;tank_id:string|null}[];source_kind?:string|null;reward_instance_id?:string|null;inventory?:{item_id:string|null;before:number|null;after:number|null;delta:number|null;status:string|null;tank_id:string|null};progress?:{elapsed_seconds:number|null;checkpoint_minutes:number|null}};
type Row={water:number;client_event_id:string;event_name:string;occurred_at_ms:number;received_at_ms:number;clock_suspicious:number;properties_json:string};
const number=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&Math.abs(v)<=1e9?v:null;
const text=(v:unknown)=>typeof v==='string'&&v.length<=256&&/^[A-Za-z0-9_.:/@+\-]*$/.test(v)?v:null;
function project(r:Row):Observation|null{let p:Record<string,any>;try{p=JSON.parse(r.properties_json);}catch{return null;}if(!p||typeof p!=='object'||Array.isArray(p)||!names[r.event_name])return null;const kind=names[r.event_name];
 const e:Observation={event_id:r.client_event_id,event_name:r.event_name,kind,occurred_at_ms:r.occurred_at_ms,received_at_ms:r.received_at_ms,logical_day:text(p.logical_day),time_status:r.clock_suspicious?'clock_suspect':'reported',source_mode:'unknown'};
 if(kind==='rewards'){e.source_kind=text(p.source_kind);e.reward_instance_id=text(p.reward_instance_id);e.rewards=Array.isArray(p.rewards)?p.rewards.slice(0,32).filter((v:any)=>v&&text(v.item_id)).map((v:any)=>({item_id:text(v.item_id)!,kind:text(v.kind)??'unknown',quantity:number(v.quantity),tank_id:text(v.tank_id)})):[];}
 else if(kind==='progress')e.progress={elapsed_seconds:number(p.elapsed_seconds),checkpoint_minutes:number(p.checkpoint_minutes)};
 else e.inventory={item_id:kind==='makeup_cards'?'M-CARD-001':text(p.item_id),before:number(kind==='inventory'?p.before_quantity:p.before),after:number(kind==='inventory'?p.quantity:p.after),delta:number(p.delta),status:text(p.status),tank_id:text(p.tank_id)};
 return e;
}
export const emptyObservationCoverage=()=>({complete:false as const,reason:'retained_observations',raw_retention_days:14,first_occurred_at_ms:null as number|null,last_occurred_at_ms:null as number|null,first_received_at_ms:null as number|null,last_received_at_ms:null as number|null});
export function emptyObservations(reason='not_enabled'){return {available:false,reason,source:'analytics_event',origin_verified:false,mode_status:'unverified',coverage:emptyObservationCoverage(),counts:Object.fromEntries(observationKinds.map(x=>[x,0])) as Record<ObservationKind,number>,latest:Object.fromEntries(observationKinds.map(x=>[x,null])) as Record<ObservationKind,Observation|null>};}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Cursor={v:1;scope:string;filter:string;water:number;anchor:string;last:[number,string];expires:number};
const key=(secret:string)=>{if(!secret)throw new ObservationError(503,'observations_dependency_unavailable');return createHash('sha256').update('p003.observations.cursor\0'+secret).digest();};
function encode(c:Cursor,secret:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv),body=Buffer.concat([cipher.update(JSON.stringify(c)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');}
function decode(s:string,secret:string):Cursor{try{if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error();const b=Buffer.from(s,'base64url'),d=createDecipheriv('aes-256-gcm',key(secret),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));const c=JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());if(c.v!==1||!Number.isSafeInteger(c.water)||c.water<0||typeof c.anchor!=='string'||typeof c.scope!=='string'||typeof c.filter!=='string'||!Number.isSafeInteger(c.expires)||!Array.isArray(c.last)||c.last.length!==2||!Number.isSafeInteger(c.last[0])||typeof c.last[1]!=='string')throw Error();return c;}catch{throw new ObservationError(400,'invalid_cursor');}}
/** Existing raw rows stay immutable. This projection deliberately does not apply normal/day/grant
 * filters: caller must supply explicit legacy authorization and recheck it after releasing snapshots. */
export function readObservationData(db:DatabaseSync,deviceKey:string,input:ObservationQuery,scope:string,secret:string,now=Date.now()){
 const parsed=ObservationQuerySchema.safeParse(input);if(!parsed.success)throw new ObservationError(400,'invalid_query');if(!/^[a-f0-9]{64}$/.test(deviceKey))throw new ObservationError(404,'not_found');const {cursor,...q}=parsed.data,filter=hash(q),scopeHash=hash(scope),c=cursor?decode(cursor,secret):null;
 if(c&&(c.scope!==scopeHash||c.filter!==filter))throw new ObservationError(400,'invalid_cursor');if(c&&c.expires<=now)throw new ObservationError(410,'cursor_expired');
 db.exec('BEGIN');try{
  if(c&&!db.prepare('SELECT 1 FROM analytics_event WHERE rowid=? AND client_event_id=? AND device_key=?').get(c.water,c.anchor,deviceKey))throw new ObservationError(410,'cursor_expired');
  const anchor=c??db.prepare('SELECT rowid water,client_event_id anchor FROM analytics_event WHERE device_key=? ORDER BY rowid DESC LIMIT 1').get(deviceKey) as {water:number;anchor:string}|undefined,water=anchor?.water??0;
  const rows=db.prepare(`SELECT rowid water,client_event_id,event_name,occurred_at_ms,received_at_ms,clock_suspicious,properties_json FROM analytics_event WHERE device_key=? AND rowid<=? AND event_name IN (${Object.keys(names).map(()=>'?').join(',')}) ORDER BY occurred_at_ms DESC,client_event_id DESC LIMIT 5001`).all(deviceKey,water,...Object.keys(names)) as unknown as Row[];
  if(rows.length>5000)throw new ObservationError(503,'observations_query_limit');
  const items=rows.map(project).filter((r):r is Observation=>r!==null),summary=emptyObservations(items.length?'partial_history':'no_observations');summary.available=!!items.length;
  for(const i of items){summary.counts[i.kind]++;if(!summary.latest[i.kind])summary.latest[i.kind]=i;}
  if(items.length){const occurred=items.filter(x=>x.time_status==='reported').map(x=>x.occurred_at_ms);summary.coverage={...summary.coverage,first_occurred_at_ms:occurred.length?Math.min(...occurred):null,last_occurred_at_ms:occurred.length?Math.max(...occurred):null,first_received_at_ms:Math.min(...items.map(x=>x.received_at_ms)),last_received_at_ms:Math.max(...items.map(x=>x.received_at_ms))};}
  const from=q.from_day?Date.parse(q.from_day+'T00:00:00+08:00'):null,to=q.to_day?Date.parse(q.to_day+'T00:00:00+08:00')+86400000:null;
  const selected=items.filter(x=>(q.kind==='all'||x.kind===q.kind)&&(from===null||(x.time_status==='reported'&&x.occurred_at_ms>=from))&&(to===null||(x.time_status==='reported'&&x.occurred_at_ms<to))&&(!c||x.occurred_at_ms<c.last[0]||(x.occurred_at_ms===c.last[0]&&x.event_id<c.last[1]))),visible=selected.slice(0,q.limit),last=visible.at(-1),more=selected.length>q.limit;
  const next_cursor=more&&last&&anchor?encode({v:1,scope:scopeHash,filter,water,anchor:anchor.anchor,last:[last.occurred_at_ms,last.event_id],expires:c?.expires??now+1800000},secret):null;
  const result={summary,progress:items.filter(x=>x.kind==='progress'),page:{schema_version:1,source:'analytics_event',origin_verified:false,mode_status:'unverified',items:visible,next_cursor,has_more:more,coverage:summary.coverage}};db.exec('COMMIT');return result;
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
}
