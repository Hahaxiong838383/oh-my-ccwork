import { sameJsonContent } from './structure.js';
import { randomUUID } from 'node:crypto';
import { AnalyticsStore,cstDay,analysisDay } from './store.js';
import {canonicalJson,digest,validateAnalyticsEvent,type AnalyticsBatch,type AnalyticsBatchAck,type RejectReason} from './contracts.js';
import type { AnalyticsDeviceContext } from './device-context.js';
import {recordAnalyticsTransport,type AnalyticsTransport} from './transport.js';
import {eventTier,authorizeDiagnostic} from './tiers.js';
export function settleAnalyticsBatch(store:AnalyticsStore,context:AnalyticsDeviceContext,batch:AnalyticsBatch,requestId:string,receivedAt=Date.now(),transport?:AnalyticsTransport):AnalyticsBatchAck{
  const started=performance.now();
  const grouped=new Map<string,unknown[]>();
  for(const raw of batch.events){const id=(raw as {client_event_id:string}).client_event_id;grouped.set(id,[...(grouped.get(id)??[]),raw]);}
  const attempt=randomUUID();
  return store.transaction(()=>{
    const statements=store.ingest;
    const ack:AnalyticsBatchAck={ok:true,request_id:requestId,accepted_event_ids:[],duplicated_event_ids:[],rejected:[],retry_after_ms:0};
    const settlements:{id:string;outcome:string;reason:RejectReason|null}[]=[];
    const metrics=new Map<string,{tier:string;source:string;records:number;count:number;bytes:number}>();
    for(const [id,items] of grouped){
      let reason:RejectReason|null=null;
      if(items.some(item=>!sameJsonContent(items[0],item))) reason='client_event_id_conflict';
      const validated=validateAnalyticsEvent(items[0]);
      if(!reason&&!validated.ok)reason=validated.reason;
      if(reason){ack.rejected.push({client_event_id:id,reason});settlements.push({id,outcome:'rejected',reason});continue;}
      if(!validated.ok)throw new Error('INVALID_EVENT_STATE');
      const event=validated.event,idHash=digest(id),tier=eventTier(event.event_name),encoded=canonicalJson(event);
      // A v375 sample keeps its ID across requests; only its routing context/session changes.
      // Preserve the source payload identity while excluding request-specific transport metadata.
      const hash=digest(tier==='diagnostic'?canonicalJson({...event,context:{analytics_tier:event.context.analytics_tier},session_id:'diagnostic'}):encoded);
      const seen=statements.seen.get(context.deviceKey,idHash) as {event_hash:string}|undefined;
      if(seen){
        if(seen.event_hash===hash){ack.duplicated_event_ids.push(id);settlements.push({id,outcome:'duplicated',reason:null});}
        else {ack.rejected.push({client_event_id:id,reason:'client_event_id_conflict'});settlements.push({id,outcome:'rejected',reason:'client_event_id_conflict'});}
        continue;
      }
      // A bucket is a final count, never a live snapshot. Check the authoritative
      // receipt clock after replay detection so an accepted ID remains settled.
      if(tier==='aggregate'&&(event.properties.period_end_ms as number)>receivedAt){
        ack.rejected.push({client_event_id:id,reason:'invalid_properties'});settlements.push({id,outcome:'rejected',reason:'invalid_properties'});continue;
      }
      if(tier==='diagnostic'){
        const denied=authorizeDiagnostic(statements,context,event,receivedAt);
        if(denied){ack.rejected.push({client_event_id:id,reason:denied});settlements.push({id,outcome:'rejected',reason:denied});continue;}
      }
      const occurredDay=analysisDay(event.occurred_at_ms,receivedAt),receivedDay=cstDay(receivedAt);
      const values=[context.deviceKey,id,event.event_name,event.occurred_at_ms,receivedAt,event.session_id,event.sequence,event.priority,canonicalJson(event.context),canonicalJson(event.properties),attempt,occurredDay,receivedDay,occurredDay===null?1:0];
      const source=tier==='raw'?event.event_name:event.properties.source_event_name as string,count=tier==='aggregate'?event.properties.count as number:1;
      if(tier==='raw')statements.event.run(...values);
      else statements.tierEvent.run(...values,tier,source,count,tier==='diagnostic'?event.context.request_id as string:null);
      statements.remember.run(context.deviceKey,idHash,hash,receivedAt);
      const metricKey=tier+':'+source,metric=metrics.get(metricKey)??{tier,source,records:0,count:0,bytes:0};metric.records++;metric.count+=count;metric.bytes+=Buffer.byteLength(encoded);metrics.set(metricKey,metric);
      const semantic:Record<string,unknown>={};
      for(const key of ['command','error_code','logical_day','tank_id','stage_id','state','kind','source_kind','status','gm_override','used_makeup_card','interactive'])if(Object.hasOwn(event.properties,key))semantic[key]=event.properties[key];
      if(typeof event.properties.reward_instance_id==='string')semantic.reward_instance_digest=digest(event.properties.reward_instance_id);
      for(const [dimension,day] of [['received',receivedDay],['occurred',occurredDay]])if(day&&tier==='raw'){
        statements.fact.run(dimension!,day,context.deviceKey,idHash,event.event_name,digest(event.session_id),occurredDay===null?1:0,canonicalJson(semantic),receivedAt);
        statements.dirty.run(dimension!,day);
      }
      ack.accepted_event_ids.push(id);settlements.push({id,outcome:'accepted',reason:null});
    }
    for(const m of metrics.values())statements.tierDay.run(cstDay(receivedAt),context.deviceKey,m.tier,m.source,m.records,m.count,m.bytes);
    statements.batch.run(attempt,requestId,batch.batch_id,context.deviceKey,receivedAt,batch.sent_at_ms,canonicalJson(batch.client),ack.accepted_event_ids.length,ack.duplicated_event_ids.length,ack.rejected.length,200,Math.ceil(performance.now()-started));
    recordAnalyticsTransport(statements,attempt,cstDay(receivedAt),context.deviceKey,transport);
    const insert=statements.settlement;
    for(const s of settlements)insert.run(attempt,digest(s.id),s.outcome,s.reason);
    return ack;
  });
}
