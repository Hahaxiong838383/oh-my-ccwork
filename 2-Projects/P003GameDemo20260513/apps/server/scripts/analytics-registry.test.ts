import assert from 'node:assert/strict';
const {RAW_EVENT_REGISTRY:EVENT_REGISTRY,matchesSchema}=await import('../src/analytics/event-registry-v1.js');
const {validateAnalyticsEvent,validateAnalyticsBatch}=await import('../src/analytics/contracts.js');
assert.equal(EVENT_REGISTRY.length,57);
for(const entry of EVENT_REGISTRY){
 const ev={schema_version:1,client_event_id:'fixture-'+entry.eventName,event_name:entry.eventName,occurred_at_ms:Date.now(),session_id:'fixture-session',sequence:1,priority:'normal',context:{},properties:entry.sample};
 assert.deepEqual(validateAnalyticsEvent(ev),{ok:true,event:ev},entry.eventName+' producer sample');
 assert.equal(validateAnalyticsEvent({...ev,properties:{...entry.sample,child_nickname:'sensitive'}}).ok,false);
 assert.equal(validateAnalyticsEvent({...ev,properties:{truncated:true}}).ok,true,entry.eventName+' producer oversized fallback');
 const schema=(entry.jsonSchema as any).oneOf[0];
 for(const [key,prop] of Object.entries(schema.properties??{}) as [string,any][]){
  if(Object.hasOwn(entry.sample,key) && prop.type!=='object' && !Array.isArray(prop.type))assert.equal(matchesSchema({...entry.sample,[key]:{unexpected:'payload'}},schema),false,entry.eventName+'.'+key+' bad type');
 }
}
let nullableBranches=0;
for(const entry of EVENT_REGISTRY){
 const schema=(entry.jsonSchema as any).oneOf[0];
 for(const [key,property] of Object.entries(schema.properties??{}) as [string,any][]){
  if(Array.isArray(property.type)&&property.type.includes('null')){
   nullableBranches++;
   const properties={...entry.sample,[key]:null};
   assert.equal(matchesSchema(properties,schema),true,entry.eventName+'.'+key+' accepts null');
   assert.equal(matchesSchema({...entry.sample,[key]:{wrong:'object'}},schema),false,entry.eventName+'.'+key+' rejects wrong object');
   assert.equal(validateAnalyticsEvent({schema_version:1,client_event_id:'nullable-'+entry.eventName,event_name:entry.eventName,occurred_at_ms:1,session_id:'nullable',sequence:1,priority:'normal',context:{},properties}).ok,true);
   assert.equal(validateAnalyticsEvent({schema_version:1,client_event_id:'nullable-'+entry.eventName,event_name:entry.eventName,occurred_at_ms:1,session_id:'nullable',sequence:1,priority:'normal',context:{},properties:{...properties,[key]:{wrong:'object'}}}).ok,false);
  }
 }
}
assert.equal(nullableBranches,1,'固定producer当前恰有一个nullable分支，新增时需明确覆盖');
const base={schema_version:1,client_event_id:'nested',event_name:'g1.reward_granted',occurred_at_ms:Date.now(),session_id:'s',sequence:1,priority:'critical',context:{},properties:EVENT_REGISTRY.find(x=>x.eventName==='g1.reward_granted')!.sample};
assert.equal(validateAnalyticsEvent({...base,occurred_at_ms:-1}).ok,true,'设备时钟偏差保留原值不能拒收');
assert.equal(validateAnalyticsEvent({...base,context:{child_name:'x'}}).ok,false);
assert.equal(validateAnalyticsEvent({...base,properties:{...base.properties,rewards:[{child_name:'sensitive'}]}}).ok,false);
assert.throws(()=>validateAnalyticsBatch({schema_version:1,batch_id:'b',sent_at_ms:1,client:{token:'secret'},events:[base]}),/INVALID_BATCH/);
assert.throws(()=>validateAnalyticsBatch({schema_version:1,batch_id:'b',sent_at_ms:1,client:{protocol_version:1},events:[base]}),/INVALID_BATCH/);
assert.throws(()=>validateAnalyticsBatch({schema_version:1,batch_id:'b',sent_at_ms:1,client:{product:'free text here'},events:[base]}),/INVALID_BATCH/);
console.log('analytics registry: PASS (57 source-derived samples, truncated compatibility, field types, sensitive/extra/nested keys)');
