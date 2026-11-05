/** 根据52b89ec9生成的合成信封；不是APK/PCK运行输出，不包含真实身份。 */
import {createHash} from 'node:crypto';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const DAY=86_400_000,CST=28_800_000;

export function aggregateFixture(now=Date.now()){
 const periodDays=7,duration=periodDays*DAY;
 const end=Math.floor((now+CST)/duration)*duration-CST,start=end-duration;
 const bucket=sha('settings.closed|'+start);
 return {schema_version:1,client_event_id:'g2agg-'+bucket.slice(0,32),
   event_name:'analytics.periodic_aggregate',occurred_at_ms:end-1,
   session_id:'aggregate-'+bucket.slice(0,16),sequence:1,priority:'normal',
   context:{analytics_tier:'periodic_aggregate',component:'godot_g1_demo'},
   properties:{source_event_name:'settings.closed',period_start_ms:start,period_end_ms:end,period_days:periodDays,
     first_occurred_at_ms:start+1000,last_occurred_at_ms:end-1000,count:20,dimensions:{},measurements:{}}};
}

export function sampleFixture(requestId:string,now=Date.now()){
 const captured=now-1000,day=Math.trunc((captured+CST)/DAY);
 const sample=sha(day+'|app.bridge_ready|{}|on_demand');
 return {schema_version:1,client_event_id:'g2diag-'+sample.slice(0,32),
   event_name:'analytics.on_demand_sample',occurred_at_ms:captured,
   session_id:'diagnostic-'+sha(requestId).slice(0,12),sequence:2,priority:'normal',
   context:{analytics_tier:'on_demand_diagnostic',request_id:requestId},
   properties:{source_event_name:'app.bridge_ready',source_occurred_at_ms:captured,
     source_context:{},source_properties:{},capture_source:'on_demand'}};
}

export function invalidFixtures(now=Date.now()){
 const aggregate=aggregateFixture(now),sample=sampleFixture('audit45-request',now);
 return [
  {name:'asset-is-not-aggregate',event:{...aggregate,properties:{...aggregate.properties,source_event_name:'g1.wallet_balance_changed'}}},
  {name:'unknown-dimension',event:{...aggregate,properties:{...aggregate.properties,dimensions:{transcript:'synthetic disallowed text'}}}},
  {name:'negative-count',event:{...aggregate,properties:{...aggregate.properties,count:-1}}},
  {name:'unfinished-period',event:{...aggregate,properties:{...aggregate.properties,period_end_ms:now+DAY}}},
  {name:'request-in-wrong-location',event:{...sample,context:{analytics_tier:'on_demand_diagnostic'},properties:{...sample.properties,request_id:'audit45-request'}}},
  {name:'asset-is-not-sample',event:{...sample,properties:{...sample.properties,source_event_name:'g1.reward_granted'}}},
  {name:'wrong-capture-source',event:{...sample,properties:{...sample.properties,capture_source:'aggregate_sample'}}},
 ];
}
