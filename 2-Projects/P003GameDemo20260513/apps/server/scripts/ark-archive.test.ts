import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ArkStore} from '../src/ark/store.js';
import {snapshotSchema} from '../src/ark/contracts.js';
import {spawnSync} from 'node:child_process';
const NOW=1794830000000;
const identity={sn:'BJP00399999999999901',account_id:'synthetic-device',epoch:1};
function snapshot(n=1,at=NOW,patch:Record<string,unknown>={}){return snapshotSchema.parse({schema_version:1,snapshot_id:'s-'+n,captured_at_ms:at,boot_id:'boot-a',boot_started_at_ms:NOW-60000,sequence:n,logical_day:'2026-11-16',config_revision:'r1',content_version:'v1',source_mode:'normal',wallets:{family_coin:0,stardust:null},inventory:{'M-CARD-001':2},progress:{timer_state:'running',next_reward:{status:'locked',kind:'currency',item_id:'C-FAMILY-001',stage_id:'stage-1',remaining_seconds:120},claimable_count:0},...patch});}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'ark-archive-')),file=join(root,'ark.db');
 const policy={enabled:true,limitBytes:8*1024**3,reserveBytes:4.5*1024**3,freeBytes:100*1024**3};
 const open=()=>new (ArkStore as any)(file,undefined,()=>({...policy})) as ArkStore;
 const store=open();store.authorize(identity,NOW);
 return {root,file,store,policy,open,done(){store.close();rmSync(root,{recursive:true,force:true});}};
}
function rows(s:ArkStore):any[]{if(!s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ark_archive_outbox'").get())return [];return s.db.prepare('SELECT * FROM ark_archive_outbox ORDER BY id').all();}
test('accepted first snapshot atomically creates one checkpoint with immutable identity and hash',()=>{const f=fixture();try{
 assert.equal(f.store.accept(identity,snapshot(),NOW).status,'accepted');assert.equal(rows(f.store).length,1);
 const e=JSON.parse(rows(f.store)[0].envelope);assert.equal(e.sn,identity.sn);assert.equal(e.account_id,identity.account_id);assert.equal(e.epoch,1);assert.equal(e.source_mode,'normal');assert.equal(e.snapshot.wallets.family_coin,0);assert.equal(e.snapshot.wallets.stardust,null);assert.equal(e.received_at_ms,NOW);assert.match(e.body_hash,/^[a-f0-9]{64}$/);
 assert.equal(f.store.accept(identity,snapshot(),NOW+1000).status,'duplicate');assert.equal(rows(f.store).length,1);
}finally{f.done();}});
test('noise never moves five-minute checkpoint baseline and exact boundary archives',()=>{const f=fixture();try{
 f.store.accept(identity,snapshot(),NOW);
 f.store.accept(identity,snapshot(2,NOW+299999,{progress:{timer_state:'paused',next_reward:{status:'locked',kind:'currency',item_id:'C-FAMILY-001',stage_id:'stage-1',remaining_seconds:17},claimable_count:0}}),NOW+299999);
 assert.equal(rows(f.store).length,1);f.store.accept(identity,snapshot(3,NOW+300000),NOW+300000);assert.equal(rows(f.store).length,2);
}finally{f.done();}});
test('assets, claim state, logical day and source mode trigger without waiting',()=>{const f=fixture();try{
 let n=1;for(const patch of [{},{wallets:{family_coin:null,stardust:0}},{inventory:{'M-CARD-001':1}},{source_mode:'gm'},{source_mode:'unknown'},{logical_day:'2026-11-17'},{content_version:'v2'},{config_revision:'r2'},{progress:{timer_state:'running',next_reward:{status:'claimable',kind:'currency',item_id:'C-FAMILY-001',stage_id:'stage-1',remaining_seconds:0},claimable_count:1}}]){f.store.accept(identity,snapshot(n,NOW+n,patch),NOW+n);n++;}assert.equal(rows(f.store).length,9);
}finally{f.done();}});
test('full buffer rolls back latest and history but does not block duplicate or noise',()=>{const f=fixture();try{
 f.store.accept(identity,snapshot(),NOW);f.policy.limitBytes=1;
 assert.equal(f.store.accept(identity,snapshot(),NOW+1).status,'duplicate');
 assert.equal(f.store.accept(identity,snapshot(2,NOW+1),NOW+1).status,'accepted');
 assert.throws(()=>f.store.accept(identity,snapshot(3,NOW+2,{wallets:{family_coin:1,stardust:null}}),NOW+2),/archive_buffer_full/);
 assert.equal(f.store.current(identity)?.snapshot.sequence,2);assert.equal(rows(f.store).length,1);
}finally{f.done();}});
test('actual local free-space reserve is enforced without contacting NAS',()=>{const f=fixture();try{
 f.policy.freeBytes=f.policy.reserveBytes;assert.throws(()=>f.store.accept(identity,snapshot(),NOW),/archive_buffer_full/);assert.equal(f.store.current(identity),null);assert.equal(rows(f.store).length,0);
}finally{f.done();}});
test('free disk also reserves the accumulated queue, not only the arriving row',()=>{const f=fixture();try{
 f.store.accept(identity,snapshot(),NOW);const cost=rows(f.store)[0].reserved_bytes;
 f.policy.freeBytes=f.policy.reserveBytes+cost+100;
 const next=snapshot(2,NOW+1,{wallets:{family_coin:1,stardust:null}});
 assert.throws(()=>f.store.accept(identity,next,NOW+1),/archive_buffer_full/);
 assert.equal(rows(f.store).length,1);assert.equal(f.store.current(identity)?.snapshot.sequence,1);
 f.policy.freeBytes=f.policy.reserveBytes+cost*2+100;
 assert.equal(f.store.accept(identity,next,NOW+1).status,'accepted');assert.equal(rows(f.store).length,2);
}finally{f.done();}});
test('archive disabled preserves old acceptance and does not discard already accepted history',()=>{const f=fixture();try{
 f.store.accept(identity,snapshot(),NOW);f.policy.enabled=false;f.policy.freeBytes=0;f.store.accept(identity,snapshot(2,NOW+1,{wallets:{family_coin:6,stardust:1}}),NOW+1);assert.equal(rows(f.store).length,1);assert.equal(f.store.current(identity)?.snapshot.wallets.family_coin,6);
}finally{f.done();}});
test('checkpoint insertion failure rolls back current and SQL transaction',()=>{const f=fixture();try{
 f.store.accept(identity,snapshot(),NOW);f.store.db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON ark_archive_outbox BEGIN SELECT RAISE(ABORT,'isolated_fault'); END");
 assert.throws(()=>f.store.accept(identity,snapshot(2,NOW+1,{wallets:{family_coin:1,stardust:null}}),NOW+1),/isolated_fault/);assert.equal(f.store.current(identity)?.snapshot.sequence,1);assert.equal(f.store.db.isTransaction,false);
}finally{f.done();}});
test('rebind retains old pending history without granting old identity or conflating new boot IDs',()=>{const f=fixture();try{
 f.store.accept(identity,snapshot(),NOW);const next={...identity,account_id:'different-device-account',epoch:2};f.store.authorize(next,NOW+1);
 assert.equal(f.store.current(identity),null);f.store.accept(next,snapshot(1,NOW+1),NOW+1);assert.equal(rows(f.store).length,2);
 f.store.accept(next,snapshot(2,NOW+2,{snapshot_id:'s-1',boot_id:'new-boot',boot_started_at_ms:NOW+2,wallets:{family_coin:3,stardust:null}}),NOW+2);assert.equal(rows(f.store).length,3);
 assert.deepEqual(rows(f.store).map(r=>JSON.parse(r.envelope).epoch),[1,2,2]);
}finally{f.done();}});
test('reopening DB keeps checkpoint cadence and accepted evidence',()=>{const f=fixture();try{
 f.store.accept(identity,snapshot(),NOW);const second=f.open();try{second.accept(identity,snapshot(2,NOW+1),NOW+1);assert.equal(rows(second).length,1);}finally{second.close();}
}finally{f.done();}});
test('fifty independent synthetic identities retain exact distinct asset values',()=>{const f=fixture();try{
 for(let n=1;n<=50;n++){const i={sn:'BJP0039999999999'+String(n).padStart(4,'0'),account_id:'device-'+n,epoch:1};f.store.authorize(i,NOW);f.store.accept(i,snapshot(1,NOW,{wallets:{family_coin:n,stardust:n+100},inventory:{'M-CARD-001':n}}),NOW);}
 const all=rows(f.store).map(r=>JSON.parse(r.envelope));assert.equal(all.length,50);assert.equal(new Set(all.map(e=>e.sn)).size,50);assert.deepEqual(all.map(e=>e.snapshot.wallets.family_coin),Array.from({length:50},(_,i)=>i+1));
}finally{f.done();}});
test('exact budget is accepted and one byte less refuses without partial commit',()=>{
 const measure=fixture();let cost=0;try{measure.store.accept(identity,snapshot(),NOW);cost=rows(measure.store)[0].reserved_bytes;}finally{measure.done();}
 for(const delta of [-1,0,1]){const f=fixture();try{f.policy.limitBytes=cost+delta;if(delta<0){assert.throws(()=>f.store.accept(identity,snapshot(),NOW),/archive_buffer_full/);assert.equal(f.store.current(identity),null);}else assert.equal(f.store.accept(identity,snapshot(),NOW).status,'accepted');}finally{f.done();}}
});
test('real SIGKILL before commit rolls back both, after commit preserves both',()=>{
 for(const stage of ['before','after']){const f=fixture();try{
  const code=`import {ArkStore} from './src/ark/store.ts';const s=new ArkStore(process.argv[1],undefined,()=>({enabled:true,limitBytes:1e9,reserveBytes:0,freeBytes:1e12}));s.db.function('crash',()=>{process.kill(process.pid,'SIGKILL');return 1;});if(process.argv[2]==='before')s.db.exec("CREATE TEMP TRIGGER crash_before_current BEFORE INSERT ON ark_current BEGIN SELECT crash(); END");s.accept(${JSON.stringify(identity)},${JSON.stringify(snapshot())},${NOW});process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['--experimental-sqlite','--import','tsx','--input-type=module','-e',code,f.file,stage],{encoding:'utf8'});assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(rows(f.store).length,stage==='before'?0:1);assert.equal(!!f.store.current(identity),stage==='after');
 }finally{f.done();}}
});
