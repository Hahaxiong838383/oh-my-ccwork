import { sameJsonContent } from './structure.js';
import { randomUUID } from 'node:crypto';
import { AnalyticsStore,cstDay,analysisDay } from './store.js';
import {canonicalJson,digest,validateAnalyticsEvent,type AnalyticsBatch,type AnalyticsBatchAck,type RejectReason} from './contracts.js';
import type { AnalyticsDeviceContext } from './device-context.js';
export function settleAnalyticsBatch(store:AnalyticsStore,context:AnalyticsDeviceContext,batch:AnalyticsBatch,requestId:string,receivedAt=Date.now()):AnalyticsBatchAck{
  const started=performance.now();
  const grouped=new Map<string,unknown[]>();
  for(const raw of batch.events){const id=(raw as {client_event_id:string}).client_event_id;grouped.set(id,[...(grouped.get(id)??[]),raw]);}
  const attempt=randomUUID();
  return store.transaction(()=>{
    const statements=store.ingest;
    const ack:AnalyticsBatchAck={ok:true,request_id:requestId,accepted_event_ids:[],duplicated_event_ids:[],rejected:[],retry_after_ms:0};
    const settlements:{id:string;outcome:string;reason:RejectReason|null}[]=[];
    for(const [id,items] of grouped){
      let reason:RejectReason|null=null;
      if(items.some(item=>!sameJsonContent(items[0],item))) reason='client_event_id_conflict';
      const validated=validateAnalyticsEvent(items[0]);
      if(!reason&&!validated.ok)reason=validated.reason;
      if(reason){ack.rejected.push({client_event_id:id,reason});settlements.push({id,outcome:'rejected',reason});continue;}
      if(!validated.ok)throw new Error('INVALID_EVENT_STATE');
      const event=validated.event,idHash=digest(id),hash=digest(canonicalJson(event));
      const seen=statements.seen.get(context.deviceKey,idHash) as {event_hash:string}|undefined;
      if(seen){
        if(seen.event_hash===hash){ack.duplicated_event_ids.push(id);settlements.push({id,outcome:'duplicated',reason:null});}
        else {ack.rejected.push({client_event_id:id,reason:'client_event_id_conflict'});settlements.push({id,outcome:'rejected',reason:'client_event_id_conflict'});}
        continue;
      }
      const occurredDay=analysisDay(event.occurred_at_ms,receivedAt),receivedDay=cstDay(receivedAt);
      statements.event.run(context.deviceKey,id,event.event_name,event.occurred_at_ms,receivedAt,event.session_id,event.sequence,event.priority,canonicalJson(event.context),canonicalJson(event.properties),attempt,occurredDay,receivedDay,occurredDay===null?1:0);
      statements.remember.run(context.deviceKey,idHash,hash,receivedAt);
      const semantic:Record<string,unknown>={};
      for(const key of ['command','error_code','logical_day','tank_id','stage_id','state','kind','source_kind','status','gm_override','used_makeup_card','interactive'])if(Object.hasOwn(event.properties,key))semantic[key]=event.properties[key];
      if(typeof event.properties.reward_instance_id==='string')semantic.reward_instance_digest=digest(event.properties.reward_instance_id);
      for(const [dimension,day] of [['received',receivedDay],['occurred',occurredDay]])if(day){
        statements.fact.run(dimension!,day,context.deviceKey,idHash,event.event_name,digest(event.session_id),occurredDay===null?1:0,canonicalJson(semantic),receivedAt);
        statements.dirty.run(dimension!,day);
      }
      ack.accepted_event_ids.push(id);settlements.push({id,outcome:'accepted',reason:null});
    }
    statements.batch.run(attempt,requestId,batch.batch_id,context.deviceKey,receivedAt,batch.sent_at_ms,canonicalJson(batch.client),ack.accepted_event_ids.length,ack.duplicated_event_ids.length,ack.rejected.length,200,Math.ceil(performance.now()-started));
    const insert=statements.settlement;
    for(const s of settlements)insert.run(attempt,digest(s.id),s.outcome,s.reason);
    return ack;
  });
}
