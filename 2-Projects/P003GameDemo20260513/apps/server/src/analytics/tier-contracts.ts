import {readFileSync} from 'node:fs';
// Exact producer: P003 client 52b89ec9a4823eb62b424f094d613b4a09a10708,
// analytics_event_policy.gd + analytics_event_client.gd (not the permissive OpenAPI envelope).
export const AGGREGATE_DIMENSIONS:Record<string,readonly string[]>={
 'app.lifecycle_changed':['state'],'g1.screen_viewed':['screen','source','previous'],
 'g1.semantic_interaction':['intent','handled','phase','source','stage_id','tank_id','day_index','reward_kind','page','direction'],
 'g1.runtime_command_completed':['command','ok','status','changed'],'g1.progress_checkpoint':['logical_day'],
 'settings.opened':['source','auto_preview'],'settings.closed':[],'settings.page_viewed':['page'],
 'settings.value_changed':['setting','value','value_bucket','result','external_screen_connected'],
 'network.connectivity_changed':['offline','source'],'network.provisioning_state_changed':['state'],
 'voice.session_state_changed':['state','interactive'],
};
export const DIAGNOSTIC_SOURCES=[...Object.keys(AGGREGATE_DIMENSIONS),'app.bridge_ready','g1.route_state_loaded'];
const raw=JSON.parse(readFileSync(new URL('./event-property-schema-v1.json',import.meta.url),'utf8')).events as any[];
const integer={type:'integer'},sourceContext={type:'object',additionalProperties:false,properties:{screen:{type:'string',maxLength:256,pattern:'^[A-Za-z0-9_.:/@+\\-]*$'},phase:{type:'string',maxLength:256,pattern:'^[A-Za-z0-9_.:/@+\\-]*$'},external_screen_connected:{type:'boolean'}}};
const measurementKeys=['max_elapsed_seconds','max_checkpoint_minutes','max_completed_slots','max_current_slot'];
export const TIER_REGISTRY=([
 {eventName:'analytics.periodic_aggregate',group:'periodic_aggregate',sample:{},jsonSchema:{oneOf:Object.entries(AGGREGATE_DIMENSIONS).map(([name,keys])=>{
   const source=raw.find(e=>e.eventName===name)?.jsonSchema.oneOf[0];if(!source)throw new Error('MISSING_AGGREGATE_SOURCE');
   const props={source_event_name:{const:name},period_start_ms:integer,period_end_ms:integer,period_days:{type:'integer',minimum:7,maximum:31},first_occurred_at_ms:integer,last_occurred_at_ms:integer,count:{type:'integer',minimum:1,maximum:1_000_000_000},dimensions:{type:'object',additionalProperties:false,properties:Object.fromEntries(keys.map(k=>{if(!source.properties[k])throw new Error('MISSING_DIMENSION_'+name+'.'+k);return [k,source.properties[k]];}))},measurements:{type:'object',additionalProperties:false,properties:name==='g1.progress_checkpoint'?Object.fromEntries(measurementKeys.map(k=>[k,{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}])):{},required:name==='g1.progress_checkpoint'?measurementKeys:[]}};
   return {type:'object',additionalProperties:false,required:Object.keys(props),properties:props};
 })}},
 {eventName:'analytics.on_demand_sample',group:'on_demand_diagnostic',sample:{},jsonSchema:{oneOf:DIAGNOSTIC_SOURCES.map(name=>({type:'object',additionalProperties:false,required:['source_event_name','source_occurred_at_ms','source_context','source_properties','capture_source'],properties:{source_event_name:{const:name},source_occurred_at_ms:integer,source_context:sourceContext,source_properties:raw.find(e=>e.eventName===name)!.jsonSchema,capture_source:{const:Object.hasOwn(AGGREGATE_DIMENSIONS,name)?'aggregate_sample':'on_demand'}}}))}},
] as any[]);
export function tierSemanticValid(name:string,p:Record<string,any>):boolean{
 if(name==='analytics.periodic_aggregate'){
  const day=86_400_000,duration=p.period_days*day;
  if(p.period_end_ms-p.period_start_ms!==duration||(p.period_start_ms+8*3_600_000)%duration!==0)return false;
  if(p.first_occurred_at_ms<p.period_start_ms||p.last_occurred_at_ms>=p.period_end_ms||p.first_occurred_at_ms>p.last_occurred_at_ms)return false;
  if(p.source_event_name==='g1.semantic_interaction'&&p.dimensions.handled!==true)return false;
  if(p.source_event_name==='g1.runtime_command_completed'&&p.dimensions.ok!==true)return false;
 }
 if(name==='analytics.on_demand_sample'){
  if(p.source_event_name==='g1.semantic_interaction'&&p.source_properties.handled!==true)return false;
  if(p.source_event_name==='g1.runtime_command_completed'&&p.source_properties.ok!==true)return false;
 }
 return true;
}
