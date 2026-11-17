import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AnalyticsStore} from '../src/analytics/store.js';
import {validateAnalyticsBatch} from '../src/analytics/contracts.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';
import {loadDatabaseCounts} from '../deploy/analytics-smoke-and-load.mjs';
import {createStreamingAccounting,analyseRequests,readJsonl,deviceKeyForActor} from './storage-load-ledger.js';
const dir=mkdtempSync(join(tmpdir(),'p003-t5-ledger-')),stamp=Date.now();let number=0;
function fixture(){const store=new AnalyticsStore(join(dir,'db-'+number+++'.db')),before=loadDatabaseCounts(store.db);const spec={prefix:'load-t5-ledger',devices:2,events:3,batch:2};return {store,before,spec,accounting:createStreamingAccounting(spec)};}
function settle(store:AnalyticsStore,prefix:string,actor:number,offset:number,length:number){return settleAnalyticsBatch(store,{deviceKey:deviceKeyForActor(actor),active:true,uploadEnabled:true,uploadHourCst:0},validateAnalyticsBatch({schema_version:1,batch_id:prefix+'-'+actor+'-'+offset,sent_at_ms:stamp,client:{},events:Array.from({length},(_,i)=>({schema_version:1,client_event_id:prefix+'-'+actor+'-'+(offset+i),event_name:'app.session_started',occurred_at_ms:stamp,session_id:'synthetic',sequence:offset+i,priority:'normal',context:{},properties:{platform:'Android',entry_mode:'launcher'}}))}),'ledger-test');}
try{
 for(const mutation of ['none','wrong-id','wrong-owner','seen-missing','extra-row','actor-failure']){
  const {store,before,spec,accounting}=fixture();try{
   // A committed but lost ACK returns only duplicate IDs on replay.
   settle(store,spec.prefix,0,0,2);
   for(const [actor,offset,length] of [[0,0,2],[1,0,2],[0,2,1],[1,2,1]]){
    const ack=settle(store,spec.prefix,actor,offset,length);accounting.record({actor,offset,ack});
    assert.throws(()=>accounting.record({actor,offset,ack}),/order|already/);
   }
   if(mutation==='wrong-id')store.db.prepare('UPDATE analytics_event SET client_event_id=? WHERE client_event_id=?').run(spec.prefix+'-0-03',spec.prefix+'-0-2');
   if(mutation==='wrong-owner')store.db.prepare('UPDATE analytics_event SET device_key=? WHERE client_event_id=?').run('foreign-device',spec.prefix+'-0-2');
   if(mutation==='seen-missing')store.db.prepare('DELETE FROM analytics_event_seen WHERE device_key=?').run(deviceKeyForActor(0));
   if(mutation==='extra-row')settle(store,'load-extra',0,0,1);
   const r=accounting.report(store.db,before,mutation==='actor-failure'?[{}]:[]);assert.equal(r.complete,mutation==='none',mutation);
   if(mutation==='none'){assert.equal(r.events_accepted,4);assert.equal(r.events_duplicated,2);assert.equal(r.database_seen_matches,6);}
  }finally{store.close();}
 }
 const a=createStreamingAccounting({prefix:'load-test',devices:1,events:2,batch:2});
 assert.throws(()=>a.record({actor:0,offset:0,ack:{ok:true,rejected:[],accepted_event_ids:['load-test-0-0'],duplicated_event_ids:[]}}),/partition/);
 assert.equal(a.totals().batches,0);assert.throws(()=>a.record({actor:1,offset:0,ack:{}}),/actor/);
 const requests=join(dir,'requests.jsonl');writeFileSync(requests,[{actor:0,offset:0,attempt:0,status:503,ms:2},{actor:0,offset:0,attempt:1,status:200,ms:10.25},{actor:0,offset:2,attempt:0,status:200,ms:99.75}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const r=await analyseRequests(requests,join(dir,'latency.db'),{devices:1,events:3,batch:2});assert.equal(r.attempts,3);assert.equal(r.statuses['503'],1);assert.equal(r.p95,99.75);assert.equal(r.p99,99.75);assert.equal(r.successes,2);
 const bad=join(dir,'bad.jsonl');writeFileSync(bad,'{"actor":');await assert.rejects(async()=>{for await(const _ of readJsonl(bad)){}},/JSON/);
 writeFileSync(bad,'x'.repeat(300000)+'\n');await assert.rejects(async()=>{for await(const _ of readJsonl(bad)){}},/line limit/);
 writeFileSync(bad,JSON.stringify({actor:0,offset:2,attempt:0,status:200,ms:2})+'\n');await assert.rejects(analyseRequests(bad,join(dir,'bad-latency.db'),{devices:1,events:3,batch:2}),/order/);
 console.log('PASS streaming ledger: exact IDs/device/seen/delta, lost ACK, non-full batches, bounded lines, corrupt evidence and retry order, exact disk percentiles');
}finally{rmSync(dir,{recursive:true,force:true});}
