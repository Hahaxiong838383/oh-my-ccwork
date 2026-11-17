import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ArkStore} from '../src/ark/store.js';
import {snapshotSchema,cstDay} from '../src/ark/contracts.js';
import {resolveArkFacts} from '../src/ark/context.js';
import {readArkHistory} from '../src/ark/history.js';
import {AnalyticsStore} from '../src/analytics/store.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';
import {arkAdmissionLimit,VERIFIED_PROFILE_KEY} from '../src/storage/policy.js';
const root=mkdtempSync(join(tmpdir(),'p003-t5-fifty-')),now=Date.now(),day=cstDay(now),yesterday=cstDay(now-86400000);
process.env.CONFIG_DB_PATH=join(root,'config.db');
const {configStore:config}=await import('../src/config-store.js');
let archive=true;
const ark=new ArkStore(join(root,'ark.db'),{run:fn=>config.withStorageAdmission(fn),limit:()=>arkAdmissionLimit(config.storagePolicy(),config.storageProfile(),ark.settings().subjects.length)},()=>({enabled:archive,limitBytes:8*1024**3,reserveBytes:4.5*1024**3,freeBytes:100*1024**3}));
const analytics=new AnalyticsStore(join(root,'analytics.db'));
const identities=Array.from({length:50},(_,n)=>({sn:'BJP003999999'+String(n+1).padStart(8,'0'),account_id:'isolated-'+n,epoch:1}));
const key=(sn:string)=>createHash('sha256').update(sn).digest('hex');
const expectations:any[]=[];
try{
 config.setFlag(VERIFIED_PROFILE_KEY,JSON.stringify({version:1,analytics_devices:50,ark_devices:50,evidence:'SYNTHETIC-FIFTY-NOT-CAPACITY-PASS',candidate:'test',validated_at_ms:now}),'test');
 for(const [n,id] of identities.entries()){
  ark.authorize(id,now-10000);const mode=n%5===0?'gm':n%5===1?'unknown':'normal',coin=n%3===0?null:n%3===1?0:100+n,card=n%4===0?null:n;
  const snapshot=snapshotSchema.parse({schema_version:1,snapshot_id:'fifty-'+n,captured_at_ms:now,boot_id:'boot-'+n,boot_started_at_ms:now-1000,sequence:1,logical_day:day,config_revision:'test',content_version:'synthetic',source_mode:mode,wallets:{family_coin:coin,stardust:200+n},inventory:{'M-CARD-001':card},progress:{timer_state:'running',next_reward:{status:'locked',kind:'currency',item_id:'C-FAMILY-001',stage_id:'S-'+n,remaining_seconds:60+n},claimable_count:n%3}});
  assert.equal(ark.accept(id,snapshot,now).status,'accepted');
  const events=[['g1.logical_day_changed',{previous_logical_day:yesterday,logical_day:day,previous_usage_day_index:1,usage_day_index:2,gm_override:mode==='gm'}],['g1.progress_checkpoint',{logical_day:day,elapsed_seconds:300+n,checkpoint_minutes:5,completed_slots:0,current_slot:0}],['g1.reward_granted',{logical_day:day,tank_id:'TANK-001',reward_instance_id:'reward-'+n,source_kind:'progress_stage',source_id:'REGULAR-01',rewards:[{kind:'currency',item_id:'C-FAMILY-001',quantity:n+1,tank_id:''}]}]] as const;
  const ack=settleAnalyticsBatch(analytics,{deviceKey:key(id.sn),active:true,uploadEnabled:true,uploadHourCst:23},{schema_version:1,batch_id:'fifty-'+n,sent_at_ms:now,client:{},events:events.map(([event_name,properties],j)=>({schema_version:1,client_event_id:'fifty-'+n+'-'+j,event_name,occurred_at_ms:now-100+j,session_id:'fixture-'+n,sequence:j,priority:'normal',context:{},properties}))},'fifty-'+n,now);
  assert.equal(ack.rejected.length,0);assert.equal(ack.accepted_event_ids.length,3);
  const current=ark.current(id)!;assert.deepEqual(current.snapshot,snapshot);
  const history=readArkHistory(analytics,key(id.sn),now-10000,now),facts=resolveArkFacts({snapshot:current,history},now);
  if(mode==='normal'){
   assert.equal(facts.assets.family_coin?.value??null,coin);assert.equal(facts.assets.stardust?.value,200+n);assert.equal(facts.assets.makeup_card?.value??null,card);
   assert.equal(facts.progress?.remaining_seconds,60+n);assert.equal(facts.progress?.claimable_count,n%3);
   assert.equal(facts.daily?.progress_seconds,300+n);assert.deepEqual(facts.daily?.rewards,[{item_id:'C-FAMILY-001',quantity:n+1}]);
  }else{assert.equal(facts.assets.family_coin,null);assert.equal(facts.assets.stardust,null);assert.equal(facts.assets.makeup_card,null);assert.equal(facts.progress,null);assert.equal(facts.daily,undefined);}
  assert.equal(ark.current({...id,account_id:'foreign'}),null);assert.equal(ark.current({...id,epoch:0}),null);
  expectations.push({id,snapshot});
 }
 assert.equal(ark.settings().subjects.length,50);
 const before=()=>JSON.stringify({grants:ark.db.prepare('SELECT * FROM ark_grant ORDER BY sn').all(),current:ark.db.prepare('SELECT * FROM ark_current ORDER BY sn').all(),history:ark.db.prepare('SELECT * FROM ark_archive_outbox ORDER BY id').all(),seen:analytics.db.prepare('SELECT * FROM analytics_event_seen ORDER BY device_key,id_digest').all()});
 const original=before();
 // First rollback step is compatibility-preserving configuration rollback, not DB restore.
 archive=false;config.clearFlag(VERIFIED_PROFILE_KEY);
 const reopened=new ArkStore(join(root,'ark.db'));
 try{assert.equal(reopened.settings().subjects.length,50);for(const {id,snapshot} of expectations)assert.deepEqual(reopened.current(id)!.snapshot,snapshot);}finally{reopened.close();}
 assert.equal(before(),original,'rollback cannot drop >32 grants/snapshots/seen/accepted outbox');
 const id=identities[2],newIdentity={...id,account_id:'replacement-owner',epoch:2};ark.authorize(newIdentity,now+1);
 assert.equal(ark.current(id),null);assert.equal(ark.current(newIdentity),null);
 assert.equal(ark.db.prepare('SELECT count(*) n FROM ark_archive_outbox').get()!.n,50);
 console.log('PASS fifty complete fact matrices: normal/GM/unknown, both currencies/card/next reward/progress/reward subtotal, owner/epoch; >32 compatibility configuration rollback preserves grants/current/seen/outbox; not full old-code rollback or load proof');
}finally{ark.close();analytics.close();rmSync(root,{recursive:true,force:true});}
