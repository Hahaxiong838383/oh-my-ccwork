import type {DatabaseSync} from 'node:sqlite';
export type UsageEvent={event_id:string;type:string;occurred_at_ms:number;server_received_ms:number;data:Record<string,unknown>};
export type ProgressObservation={event_id:string;kind:string;occurred_at_ms:number;received_at_ms:number;time_status:string;logical_day?:string|null;progress?:{elapsed_seconds:number|null}};
const DAY=86400000,EARLIEST=1577808000000;
const day=(ms:number)=>new Date(ms+8*3600000).toISOString().slice(0,10);
const midnight=(date:string)=>Date.parse(date+'T00:00:00+08:00');
type Interval={start:number;end:number;received:number;source:string};
export const usageCoverage=()=>({complete:false as const,reason:'partial_history',presence_window_seconds:300,posture_window_seconds:60,reward_counter_policy:'calendar_day_high_water' as const});
function union(rows:Interval[]):Interval[]{const out:Interval[]=[];for(const x of rows.slice().sort((a,b)=>a.start-b.start||a.end-b.end)){const last=out.at(-1);if(last&&x.start<=last.end){last.end=Math.max(last.end,x.end);last.received=Math.max(last.received,x.received);}else out.push({...x});}return out;}
function seconds(rows:Interval[]){return Math.round(rows.reduce((s,x)=>s+x.end-x.start,0)/1000);}
function validTime(ms:unknown,now:number):ms is number{return typeof ms==='number'&&Number.isSafeInteger(ms)&&ms>=EARLIEST&&ms<=now;}
function state(data:Record<string,unknown>):boolean|null{const v=data.state??data.to??data.presence_state;if(v==='present'||v===true)return true;if(v==='absent'||v==='unknown'||v===false)return false;return typeof data.present==='boolean'?data.present:null;}
/** Estimates are explicit bounded observation windows, never a claim of complete sensor coverage.
 * Reward counters use a calendar-day high water even across session/reset replay. Located observations are
 * unioned; unlocated cumulative reward time is combined by daily max, never back-projected. */
export function buildHistoricalUsage(events:UsageEvent[],observations:ProgressObservation[],now=Date.now()){
 const measured:Interval[]=[],estimated:Interval[]=[];
 const add=(out:Interval[],start:number,end:number,received:number,source:string)=>{if(validTime(start,now)&&validTime(end,now)&&end>start)out.push({start,end,received,source});};
 const unique=new Map<string,UsageEvent>();for(const e of events)if(!unique.has(e.event_id))unique.set(e.event_id,e);
 const ordered=[...unique.values()].filter(e=>validTime(e.occurred_at_ms,now)).sort((a,b)=>a.occurred_at_ms-b.occurred_at_ms||a.event_id.localeCompare(b.event_id));
 const presence=ordered.filter(e=>e.type==='presence_transition'&&state(e.data)!==null);
 for(let i=0;i<presence.length;i++){const e=presence[i];if(state(e.data)!==true)continue;add(estimated,e.occurred_at_ms,Math.min(e.occurred_at_ms+300000,presence[i+1]?.occurred_at_ms??now,now),e.server_received_ms,'telemetry.presence_transition');}
 for(const e of ordered){if(e.type==='focus_segment'){const start=e.data.start_ms,end=e.data.end_ms;if(typeof start==='number'&&typeof end==='number'&&end-start<=DAY)add(measured,start,end,e.server_received_ms,'telemetry.focus_segment');}
  if(e.type==='posture_round'&&Number(e.data.valid_frames)>0&&['correct','deviated'].includes(String(e.data.result)))add(estimated,Math.max(midnight(day(e.occurred_at_ms)),e.occurred_at_ms-60000),e.occurred_at_ms,e.server_received_ms,'telemetry.posture_round');}
 const seen=new Set<string>(),high=new Map<string,{value:number;received:number}>();
 for(const e of observations){if(e.kind!=='progress'||seen.has(e.event_id)||e.time_status!=='reported'||!validTime(e.occurred_at_ms,now))continue;seen.add(e.event_id);
  const value=e.progress?.elapsed_seconds;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>86400)continue;
  const date=day(e.occurred_at_ms),old=high.get(date);high.set(date,{value:Math.max(value,old?.value??0),received:Math.max(e.received_at_ms,old?.received??0)});
 }
 const observed=union(measured),all=union([...measured,...estimated]);
 const dates=new Set(high.keys());for(const x of all)for(let t=midnight(day(x.start));t<x.end;t+=DAY)dates.add(day(t));
 const daily=[...dates].sort().map(date=>{const start=midnight(date),clip=(xs:Interval[])=>xs.flatMap(x=>x.end>start&&x.start<start+DAY?[{...x,start:Math.max(start,x.start),end:Math.min(start+DAY,x.end)}]:[]),rows=clip(all),counter=high.get(date),total=Math.max(seconds(rows),counter?.value??0),actual=seconds(clip(observed)),sources=[...new Set([...measured,...estimated].filter(x=>x.end>start&&x.start<start+DAY).map(x=>x.source))];if(counter)sources.push('analytics.reward_progress');return {date,available:true,focus_minutes:Math.round(total/60),total_seconds:total,observed_seconds:actual,estimated_seconds:Math.max(0,total-actual),source:sources.join('+'),updated_at_ms:Math.max(counter?.received??0,...rows.map(x=>x.received)),coverage:usageCoverage()};});
 const total=daily.length?daily.reduce((n,d)=>n+d.total_seconds,0):null,actual=daily.length?daily.reduce((n,d)=>n+d.observed_seconds,0):null;
 return {available:!!daily.length,reason:daily.length?'partial_history':'no_observations',source:'merged_observations',method:'daily_max_union_v1',total_seconds:total,total_minutes:total===null?null:Math.round(total/60),observed_seconds:actual,estimated_seconds:total===null?null:Math.max(0,total-(actual??0)),from_day:daily[0]?.date??null,to_day:daily.at(-1)?.date??null,daily,coverage:usageCoverage(),updated_at_ms:daily.length?Math.max(...daily.map(x=>x.updated_at_ms)):null};
}
export function readUsageEvents(db:DatabaseSync,sn:string){const rows=db.prepare("SELECT event_id,type,occurred_at_ms,server_received_ms,data_json FROM device_telemetry_event WHERE sn=? AND type IN ('focus_segment','presence_transition','posture_round') ORDER BY occurred_at_ms DESC,event_id LIMIT 100001").all(sn) as unknown as (Omit<UsageEvent,'data'>&{data_json:string})[];if(rows.length>100000)throw new Error('usage_query_limit');return rows.map(({data_json,...e})=>({...e,data:JSON.parse(data_json)}));}
