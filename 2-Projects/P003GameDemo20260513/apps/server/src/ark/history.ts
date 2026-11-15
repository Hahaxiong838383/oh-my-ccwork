import type {AnalyticsStore} from '../analytics/store.js';
import {cstDay,daySchema,dailyFactSchema,unknownHistory,type ArkHistory} from './contracts.js';
const DAY=86400000;
/** Full device key only. Bounded raw facts; rollups, request IDs and aliases are never authority. */
export function readArkHistory(store:AnalyticsStore,key:string,notBefore:number,now=Date.now()):ArkHistory{
 if(!/^[a-f0-9]{64}$/.test(key)||!Number.isSafeInteger(notBefore)||notBefore>now)return unknownHistory();
 return store.readSnapshot(()=>{
 const columns=`e.event_name,e.occurred_at_ms,e.received_at_ms,e.clock_suspicious,e.properties_json,b.client_json`;
 type Row={event_name:string;occurred_at_ms:number;received_at_ms:number;clock_suspicious:number;properties_json:string;client_json:string|null};
 // Normal mode and every schema-supported GM-bearing event are independent of asset volume.
 const evidence=store.db.prepare(`SELECT ${columns} FROM analytics_event e LEFT JOIN analytics_batch b ON b.attempt_id=e.batch_attempt_id
 WHERE e.device_key=? AND e.received_at_ms>=? AND e.received_at_ms<=?
 AND e.event_name IN ('g1.logical_day_changed','g1.command_failed','g1.runtime_command_completed','g1.gift_became_available','g1.gift_claimed','g1.reward_granted')
 AND (e.event_name='g1.logical_day_changed' OR json_extract(e.properties_json,'$.gm_override')=1 OR json_extract(e.properties_json,'$.source_mode')='gm'
 OR lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*gm*'
 OR lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*debug*'
 OR lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*test*')
 ORDER BY e.received_at_ms DESC LIMIT 513`).all(key,now-14*DAY,now) as Row[];
 if(evidence.length>512)return unknownHistory('query_limit');
 const facts=store.db.prepare(`SELECT ${columns} FROM analytics_event e LEFT JOIN analytics_batch b ON b.attempt_id=e.batch_attempt_id
 WHERE e.device_key=? AND e.received_at_ms>=? AND e.received_at_ms<=?
 AND e.occurred_at_ms>=? AND e.occurred_at_ms<=? AND e.event_name IN ('g1.wallet_balance_changed','g1.inventory_changed')
 ORDER BY e.occurred_at_ms DESC,e.received_at_ms DESC LIMIT 513`).all(key,Math.max(notBefore,now-14*DAY),now,Math.max(notBefore,now-14*DAY),now) as Row[];
 // Truncating older asset changes cannot invalidate an already-newer latest value.
 // A tie at the truncation boundary is ambiguous and must not be reported.
 const boundary=facts.length>512?facts[512].occurred_at_ms:null;
 const events=[...evidence,...facts.slice(0,512)].map(r=>({...r,p:JSON.parse(r.properties_json) as Record<string,unknown>}));
 // Pre-watermark rows are negative GM evidence only, never positive player facts.
 events.sort((a,b)=>b.occurred_at_ms-a.occurred_at_ms||b.received_at_ms-a.received_at_ms);
 const gmDays=new Set<string>(),normal=new Map<string,number>();
 for(const e of events){const day=cstDay(e.occurred_at_ms),p=e.p;
  if(p.gm_override===true||p.source_mode==='gm'||[p.command,p.source_kind].some(v=>typeof v==='string'&&/(?:^|[^a-z0-9])(gm|debug|test)(?:$|[^a-z0-9])/i.test(v))){gmDays.add(day);if(daySchema.safeParse(p.logical_day).success)gmDays.add(p.logical_day as string);}
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
 if(boundary!==null){if(result.wallets.family_coin&&result.wallets.family_coin.occurred_at_ms<=boundary)result.wallets.family_coin=null;if(result.inventory['M-CARD-001']&&result.inventory['M-CARD-001']!.occurred_at_ms<=boundary)result.inventory['M-CARD-001']=null;}
 // Separate bounded day scan: reward grants are not wallet deltas; aggregated diagnostics never enter.
 const today=cstDay(now),start=Date.parse(today+'T00:00:00+08:00');
 if(normal.has(today)&&!gmDays.has(today)){
  const rows=store.db.prepare(`SELECT ${columns},e.session_id FROM analytics_event e LEFT JOIN analytics_batch b ON b.attempt_id=e.batch_attempt_id
   WHERE e.device_key=? AND e.received_at_ms>=? AND e.received_at_ms<=? AND e.occurred_at_ms>=? AND e.occurred_at_ms<=?
   AND e.event_name IN ('g1.progress_checkpoint','g1.reward_granted') ORDER BY e.occurred_at_ms,e.client_event_id LIMIT 513`)
   .all(key,Math.max(notBefore,start),now,Math.max(notBefore,start),now) as (Row&{session_id:string|null})[];
  if(rows.length<=512){
   const checkpoints:{value:number;session:string|null;at:number}[]=[],grants=new Map<string,string>();
   const sums=new Map<string,number>();let invalidGrant=false,invalidProgress=false,at=0,received=0;
   for(const r of rows){const p=JSON.parse(r.properties_json);
    if(p.truncated===true||r.clock_suspicious||r.received_at_ms<r.occurred_at_ms-2000){if(r.event_name==='g1.reward_granted')invalidGrant=true;else invalidProgress=true;continue;}
    if(p.logical_day!==today||r.occurred_at_ms<normal.get(today)!)continue;
    if(r.event_name==='g1.progress_checkpoint'){
     if(Number.isSafeInteger(p.elapsed_seconds)&&p.elapsed_seconds>=0&&p.elapsed_seconds<=86400){checkpoints.push({value:p.elapsed_seconds,session:r.session_id,at:r.occurred_at_ms});at=Math.max(at,r.occurred_at_ms);received=Math.max(received,r.received_at_ms);}else invalidProgress=true;
    }else{
     if(typeof p.reward_instance_id!=='string'||!p.reward_instance_id||!Array.isArray(p.rewards)||!p.rewards.length){invalidGrant=true;continue;}
     // Stable reward instance is the idempotency key even if a replay has a new event ID.
     const rewards=p.rewards.map((v:any)=>({item_id:v.item_id,quantity:v.quantity,kind:v.kind,tank_id:v.tank_id}));
     if(rewards.some((v:any)=>typeof v.item_id!=='string'||! /^[A-Za-z0-9_.:-]{1,64}$/.test(v.item_id)||!Number.isSafeInteger(v.quantity)||v.quantity<0||v.quantity>1e9||(['C-FAMILY-001','C-STARDUST-001'].includes(v.item_id)&&v.kind!=='currency'))){invalidGrant=true;continue;}
     const digest=JSON.stringify([p.source_kind,p.source_id,p.tank_id,rewards.sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
     if(grants.has(p.reward_instance_id)){if(grants.get(p.reward_instance_id)!==digest)invalidGrant=true;continue;}
     grants.set(p.reward_instance_id,digest);
     for(const v of rewards)sums.set(v.item_id,(sums.get(v.item_id)??0)+v.quantity);
     at=Math.max(at,r.occurred_at_ms);received=Math.max(received,r.received_at_ms);
    }
   }
   // Checkpoints are capped reward-progress counters. Cross-session/reset ambiguity is not total usage.
   const monotonic=!invalidProgress&&checkpoints.every((c,i)=>c.session&&(!i||c.session===checkpoints[i-1].session&&c.value>=checkpoints[i-1].value&&(c.at!==checkpoints[i-1].at||c.value===checkpoints[i-1].value)));
   const progress_seconds=checkpoints.length&&monotonic?checkpoints.at(-1)!.value:null;
   const rewards=!invalidGrant&&grants.size?[...sums].map(([item_id,quantity])=>({item_id,quantity})):null;
   if(progress_seconds!==null||rewards!==null){const parsed=dailyFactSchema.safeParse({logical_day:today,observed_at_ms:at,received_at_ms:received,coverage:'received_records',progress_seconds,rewards});if(parsed.success)result.daily=parsed.data;}
  }
 }
 if(result.wallets.family_coin||result.inventory['M-CARD-001']||result.daily){result.status='available';result.reason='none';}
 return result;
 });
}
