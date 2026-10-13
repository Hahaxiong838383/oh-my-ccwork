import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AnalyticsStore} from '../src/analytics/store.js';
import {validateAnalyticsBatch} from '../src/analytics/contracts.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';
import {createLoadAccounting,loadDatabaseCounts} from '../deploy/analytics-smoke-and-load.mjs';

const dir=mkdtempSync(join(tmpdir(),'analytics-load-accounting-'));
const context={deviceKey:'fake-load-device',active:true,uploadEnabled:true,uploadHourCst:0};
const stamp=Date.now();
const event=(id:string)=>({schema_version:1,client_event_id:id,event_name:'app.session_started',occurred_at_ms:stamp,session_id:'load-session',sequence:1,priority:'normal',context:{},properties:{platform:'Android',entry_mode:'launcher'}});
const batch=(ids:string[])=>validateAnalyticsBatch({schema_version:1,batch_id:'batch-load-regression',sent_at_ms:stamp,client:{},events:ids.map(event)});
let caseNumber=0;
function fixture(){const store=new AnalyticsStore(join(dir,'case-'+caseNumber+++'.db'));return {store,before:loadDatabaseCounts(store.db)};}

try{
  // The first durable COMMIT succeeds but its ACK is lost; only the replay reaches the caller.
  // Counting accepted_event_ids alone must not mark this fully reconciled upload incomplete.
  {
    const {store,before}=fixture(),ids=['load-replay-0','load-replay-1'];
    try{
      const droppedAck=settleAnalyticsBatch(store,context,batch(ids),'lost-ack');
      assert.deepEqual(droppedAck.accepted_event_ids,ids);
      const replay=settleAnalyticsBatch(store,context,batch(ids),'replay-ack');
      assert.deepEqual(replay.duplicated_event_ids,ids);
      const accounting=createLoadAccounting({expectedEvents:2,expectedBatches:1});
      accounting.record(replay,ids);
      const reader=new DatabaseSync(store.path,{readOnly:true});let report;
      try{report=accounting.report(reader,'load-replay',before,[]);}finally{reader.close();}
      assert.equal(report.complete,true,'已提交后丢 ACK，重试 duplicated 全量对账应通过');
      assert.equal(report.events_accepted,0);
      assert.equal(report.events_duplicated,2);
      assert.equal(report.events_acknowledged,2);
      assert.equal(report.unique_acknowledged_events,2);
      assert.deepEqual(report.database_delta,{events:2,seen:2,batches:2});
      assert.equal(report.database_unique_event_ids,2);
      assert.equal(report.database_seen_matches,2);
      assert.throws(()=>accounting.record(replay,ids),/already acknowledged/,'同一完成批次不能重复计数');
    }finally{store.close();}
  }
  // A partial lost ACK can produce both accepted and duplicated IDs in one later response.
  {
    const {store,before}=fixture(),ids=['load-mixed-0','load-mixed-1'];
    try{
      settleAnalyticsBatch(store,context,batch(ids.slice(0,1)),'lost-partial');
      const ack=settleAnalyticsBatch(store,context,batch(ids),'mixed-replay');
      const accounting=createLoadAccounting({expectedEvents:2,expectedBatches:1});
      accounting.record(ack,ids);
      const report=accounting.report(store.db,'load-mixed',before,[]);
      assert.equal(report.complete,true);
      assert.equal(report.events_accepted,1);assert.equal(report.events_duplicated,1);
      assert.equal(accounting.report(store.db,'load-mixed',before,[{actor:0}]).complete,false,'actor失败仍须失败');
      store.db.prepare('DELETE FROM analytics_event_seen WHERE device_key=?').run(context.deviceKey);
      assert.equal(accounting.report(store.db,'load-mixed',before,[]).complete,false,'ACK不能掩盖丢失的去重账本');
    }finally{store.close();}
  }
  // Exact current-run IDs and deltas are both required, not merely matching total counts.
  {
    const {store,before}=fixture(),ids=['load-exact-0','load-exact-1'];
    try{
      const accounting=createLoadAccounting({expectedEvents:2,expectedBatches:1});
      accounting.record(settleAnalyticsBatch(store,context,batch(ids),'exact'),ids);
      store.db.prepare('UPDATE analytics_event SET client_event_id=? WHERE client_event_id=?').run('load-exact-unexpected',ids[1]);
      assert.equal(accounting.report(store.db,'load-exact',before,[]).complete,false,'数量一致但事件ID不同仍须失败');
    }finally{store.close();}
  }
  {
    const {store,before}=fixture(),ids=['load-delta-0','load-delta-1'];
    try{
      const accounting=createLoadAccounting({expectedEvents:2,expectedBatches:1});
      accounting.record(settleAnalyticsBatch(store,context,batch(ids),'delta'),ids);
      settleAnalyticsBatch(store,context,batch(['unrelated-extra']),'extra');
      assert.equal(accounting.report(store.db,'load-delta',before,[]).complete,false,'全库增量异常不能只凭当前前缀计数通过');
    }finally{store.close();}
  }
  {
    const accounting=createLoadAccounting({expectedEvents:1,expectedBatches:1});
    assert.throws(()=>accounting.record({ok:true,accepted_event_ids:['wrong-id'],duplicated_event_ids:[],rejected:[],retry_after_ms:0},['load-required']),/ACK partition/);
    assert.throws(()=>accounting.record({ok:true,accepted_event_ids:['load-required'],duplicated_event_ids:['load-required'],rejected:[],retry_after_ms:0},['load-required']),/ACK partition/);
    assert.throws(()=>accounting.record({ok:true,accepted_event_ids:[],duplicated_event_ids:[],rejected:[{client_event_id:'load-required',reason:'invalid_event'}],retry_after_ms:0},['load-required']),/rejected events/);
    assert.equal(accounting.totals().batches,0,'错误ACK不能更新完成统计');
  }
  console.log('analytics load accounting: PASS (durable ACK loss/replay, exact IDs, raw/seen deltas, no double counting)');
}finally{rmSync(dir,{recursive:true,force:true});}
