// Isolated synthetic diagnosis: separate pre-COMMIT work from durable COMMIT latency.
import assert from 'node:assert/strict';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AnalyticsStore } from '../src/analytics/store.ts';
import { settleAnalyticsBatch } from '../src/analytics/ingest.ts';
import { AnalyticsDeviceReader } from '../src/analytics/device-context.ts';
const root='/opt/p003/analytics-staging-20261013';assert.equal(resolve(process.cwd()),root+'/server');
const dir=root+'/diagnostic';mkdirSync(dir,{recursive:true,mode:0o700});
const existing=process.argv.includes('--existing-stage-db');
const store=new AnalyticsStore(existing?root+'/server/data/analytics.db':dir+'/durability-'+Date.now()+'.sqlite3');
const noAuto=process.argv.includes('--no-autocheckpoint');if(noAuto)store.db.exec('PRAGMA wal_autocheckpoint=0;');
const cacheArg=process.argv.find(value=>value.startsWith('--cache-kib='));const cacheKiB=cacheArg?Number(cacheArg.slice('--cache-kib='.length)):32768;
assert.ok([32768,65536,98304].includes(cacheKiB));store.db.exec('PRAGMA cache_size=-'+cacheKiB);
let phases={};const exec=store.db.exec.bind(store.db);
store.db.exec=sql=>{const phase=sql.split(' ')[0],began=performance.now();try{return exec(sql);}finally{phases[phase]=(phases[phase]??0)+performance.now()-began;}};
const statements=store.ingest,wrapped={};
for(const [name,statement] of Object.entries(statements)){wrapped[name]={};for(const method of ['get','run'])wrapped[name][method]=(...args)=>{const began=performance.now();try{return statement[method](...args);}finally{phases[name]=(phases[name]??0)+performance.now()-began;}};}
Object.defineProperty(store,'ingest',{get:()=>wrapped});
const catalog=JSON.parse(readFileSync('src/analytics/event-property-schema-v1.json','utf8')).events;
const context=existing?new AnalyticsDeviceReader({devicesPath:process.env.ANALYTICS_DEVICES_DB_PATH,configPath:process.env.ANALYTICS_CONFIG_DB_PATH,deviceKeySecret:process.env.ANALYTICS_DEVICE_KEY_SECRET,envAllow:[]}).readAnalyticsDeviceContext(process.env.ANALYTICS_SN_ALLOW.split(',')[0]):{deviceKey:createHash('sha256').update('synthetic-durability').digest('hex'),active:true,uploadEnabled:true,uploadHourCst:0};
const samples=[],stamp=Date.now();
try{for(let b=0;b<20;b++){
 const events=Array.from({length:200},(_,i)=>{const spec=catalog[(b*200+i)%57];return {schema_version:1,client_event_id:'durability-'+stamp+'-'+b+'-'+i,event_name:spec.eventName,occurred_at_ms:stamp,session_id:'synthetic-session',sequence:i,priority:'normal',context:{},properties:structuredClone(spec.sample)};});
 phases={};const began=performance.now();const ack=settleAnalyticsBatch(store,context,{schema_version:1,batch_id:'durability-'+b,sent_at_ms:stamp,client:{},events},'durability-'+b);const elapsed=performance.now()-began;assert.equal(ack.accepted_event_ids.length,200);
 const processing=store.db.prepare('SELECT processing_ms FROM analytics_batch WHERE request_id=?').get('durability-'+b).processing_ms;
 samples.push({total_ms:elapsed,pre_commit_ms:processing,commit_and_receipt_ms:Math.max(0,elapsed-processing),sql_phases_ms:phases,rss_bytes:process.memoryUsage().rss});
}let checkpoint=null;if(noAuto){const began=performance.now();const state=store.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();checkpoint={state,duration_ms:performance.now()-began};}const report={ok:true,synthetic_only:true,existing_stage_database:existing,cache_kib:cacheKiB,autocheckpoint_disabled:Number(store.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint)===0,explicit_no_autocheckpoint_flag:noAuto,synchronous:store.db.prepare('PRAGMA synchronous').get().synchronous,samples,checkpoint};const suffix=(existing?(noAuto?'-existing-noauto':'-existing-auto'):'')+'-cache'+cacheKiB+'-'+stamp;writeFileSync(root+'/evidence/durability-probe'+suffix+'.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));}finally{store.close();}
