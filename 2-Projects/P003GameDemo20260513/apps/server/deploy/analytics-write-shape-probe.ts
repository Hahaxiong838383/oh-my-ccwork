// Small single-variable group-COMMIT experiment on preserved synthetic staging data.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {analyticsOptionsFromEnv} from '../src/analytics/index.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';
import {validateAnalyticsBatch} from '../src/analytics/contracts.js';
const root='/opt/p003/analytics-staging-20261013';assert.equal(resolve(process.cwd()),root+'/server');
assert.equal(process.env.ANALYTICS_DB_PATH,root+'/server/data/analytics.db');
const options=analyticsOptionsFromEnv(),store=options.store,stamp=Date.now();
const catalog=JSON.parse(readFileSync('src/analytics/event-property-schema-v1.json','utf8')).events;
const contexts=options.allowSubjects.map(sn=>options.reader.readAnalyticsDeviceContext(sn));
const transaction=store.transaction.bind(store),samples:unknown[]=[];
let sequence=0;
try{
  // ABBA ordering limits one-way warm-cache bias. Each phase writes the same 20x200 events.
  for(const groupSize of [1,4,4,1]){
    const began=performance.now(),groups=[];
    for(let batchIndex=0;batchIndex<20;batchIndex+=groupSize){
      const items=Array.from({length:groupSize},()=>{
        const serial=sequence++,id='shape-'+stamp+'-'+serial;
        const events=Array.from({length:200},(_,i)=>{const spec=catalog[i%catalog.length];return {schema_version:1,client_event_id:id+'-'+i,event_name:spec.eventName,occurred_at_ms:stamp,session_id:'synthetic-session-'+i%14,sequence:i,priority:'normal',context:{},properties:structuredClone(spec.sample)};});
        return {context:contexts[serial%14],requestId:id,batch:validateAnalyticsBatch({schema_version:1,batch_id:id,sent_at_ms:stamp,client:{product:'p003',component:'synthetic_staging'},events})};
      });
      const start=performance.now();
      // Prototype only: all batches share one real FULL transaction, and ACKs are inspected
      // only after that transaction commits. The original method is always restored.
      store.transaction=<T>(fn:()=>T):T=>fn();let acks;
      try{acks=transaction(()=>items.map(item=>settleAnalyticsBatch(store,item.context,item.batch,item.requestId)));}
      finally{store.transaction=transaction;}
      assert.ok(acks.every(ack=>ack.accepted_event_ids.length===200&&ack.rejected.length===0));
      groups.push({batches:groupSize,ms:performance.now()-start,rss_bytes:process.memoryUsage().rss});
    }
    samples.push({group_size:groupSize,batches:20,events:4000,ms:performance.now()-began,groups});
  }
  const output={synthetic_only:true,synchronous:store.db.prepare('PRAGMA synchronous').get(),samples};
  writeFileSync(root+'/evidence/write-shape-'+stamp+'.json',JSON.stringify(output,null,2),{mode:0o600});console.log(JSON.stringify(output));
}finally{store.transaction=transaction;store.close();}
