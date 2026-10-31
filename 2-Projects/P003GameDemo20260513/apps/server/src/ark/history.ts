import type {AnalyticsStore} from '../analytics/store.js';
import {cstDay,daySchema,unknownHistory,type ArkHistory} from './contracts.js';
const DAY=86400000;
/** Full device key only. Bounded raw facts; rollups, request IDs and aliases are never authority. */
export function readArkHistory(store:AnalyticsStore,key:string,notBefore:number,now=Date.now()):ArkHistory{
 if(!/^[a-f0-9]{64}$/.test(key)||!Number.isSafeInteger(notBefore)||notBefore>now)return unknownHistory();
 return store.readSnapshot(()=>{
 const rows=store.db.prepare(`SELECT e.event_name,e.occurred_at_ms,e.received_at_ms,e.clock_suspicious,e.properties_json,b.client_json
 FROM analytics_event e LEFT JOIN analytics_batch b ON b.attempt_id=e.batch_attempt_id
 WHERE e.device_key=? AND e.received_at_ms>=? AND e.received_at_ms<=?
 ORDER BY e.received_at_ms DESC,e.occurred_at_ms DESC LIMIT 513`).all(key,now-14*DAY,now) as {event_name:string;occurred_at_ms:number;received_at_ms:number;clock_suspicious:number;properties_json:string;client_json:string|null}[];
 if(rows.length>512)return unknownHistory('query_limit');
 const events=rows.map(r=>({...r,p:JSON.parse(r.properties_json) as Record<string,unknown>}));
 // Pre-watermark rows are negative GM evidence only, never positive player facts.
 events.sort((a,b)=>b.occurred_at_ms-a.occurred_at_ms||b.received_at_ms-a.received_at_ms);
 const gmDays=new Set<string>(),normal=new Map<string,number>();
 for(const e of events){const day=cstDay(e.occurred_at_ms),p=e.p;
  if(p.gm_override===true||p.source_mode==='gm'||[p.command,p.source_kind].some(v=>typeof v==='string'&&/(?:^|[._:-])(gm|debug|test)(?:$|[._:-])/.test(v))){gmDays.add(day);if(daySchema.safeParse(p.logical_day).success)gmDays.add(p.logical_day as string);}
  if(e.event_name==='g1.logical_day_changed'&&e.occurred_at_ms>=Math.max(notBefore,now-14*DAY)&&e.occurred_at_ms<=now&&e.received_at_ms>=notBefore&&p.gm_override===false&&!e.clock_suspicious&&p.truncated!==true&&e.received_at_ms>=e.occurred_at_ms-2000&&e.received_at_ms-e.occurred_at_ms<=14*DAY&&p.logical_day===day)normal.set(day,Math.min(normal.get(day)??Infinity,e.occurred_at_ms));
 }
 const result=unknownHistory(),conflicts=new Set<string>();
 for(const e of events){const day=cstDay(e.occurred_at_ms),p=e.p;
  if(e.occurred_at_ms<Math.max(notBefore,now-14*DAY)||e.occurred_at_ms>now||e.received_at_ms<notBefore||e.clock_suspicious||e.received_at_ms<e.occurred_at_ms-2000||e.received_at_ms-e.occurred_at_ms>14*DAY||p.truncated===true||gmDays.has(day)||!normal.has(day)||normal.get(day)!>e.occurred_at_ms)continue;
  const value=e.event_name==='g1.wallet_balance_changed'&&p.item_id==='C-FAMILY-001'?p.after:e.event_name==='g1.inventory_changed'&&p.item_id==='M-CARD-001'?p.quantity:undefined;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>1e9)continue;
  let version:null|string=null;
  if(e.client_json){const client=JSON.parse(e.client_json);if(typeof client.content_version==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(client.content_version))version=client.content_version;}
  const fact={value,occurred_at_ms:e.occurred_at_ms,received_at_ms:e.received_at_ms,content_version:version};
  const wallet=e.event_name==='g1.wallet_balance_changed',field=wallet?'family_coin':'M-CARD-001';
  if(conflicts.has(field))continue;
  const old=wallet?result.wallets.family_coin:result.inventory['M-CARD-001'];
  if(old&&old.occurred_at_ms===fact.occurred_at_ms&&old.value!==fact.value){conflicts.add(field);if(wallet)result.wallets.family_coin=null;else result.inventory['M-CARD-001']=null;continue;}
  if(wallet)result.wallets.family_coin??=fact;else result.inventory['M-CARD-001']??=fact;
 }
 if(result.wallets.family_coin||result.inventory['M-CARD-001']){result.status='available';result.reason='none';}
 return result;
 });
}
