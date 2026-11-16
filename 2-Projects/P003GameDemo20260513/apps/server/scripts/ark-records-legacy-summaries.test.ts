/** Synthetic mini009 + v1 records in temporary SQLite only; no production data. */
import {test,after,mock,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {RecordsStore} from '../src/ark/records-store.js';
import {RecordSchema} from '../src/ark/records-contract.js';
import {LegacyRecordSchema} from '../src/ark/records-legacy.js';

const NOW=Date.parse('2026-11-16T12:00:00Z'),DAY=Date.parse('2026-11-15T00:00:00+08:00'),SN='BJP00326060100009992';
mock.timers.enable({apis:['Date'],now:NOW});after(()=>mock.timers.reset());
process.env.ARK_RECORDS_MIN_FREE_BYTES='1';
for(const k of ['UPLOAD_PER_MINUTE','UPLOAD_PER_HOUR','GLOBAL_UPLOAD_PER_MINUTE','GLOBAL_UPLOAD_PER_HOUR'])process.env[`ARK_RECORDS_${k}`]='10000';
function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'ark-legacy-summaries-')),arkPath=join(root,'ark.db'),devicesPath=join(root,'devices.db');
 const devices=new DatabaseSync(devicesPath),ark=new DatabaseSync(arkPath),grant=randomUUID();
 devices.exec(`CREATE TABLE device_registry(sn TEXT PRIMARY KEY,public_id TEXT,account_id TEXT,parent_account_id TEXT,status TEXT,binding_policy TEXT,binding_version INTEGER);
 CREATE TABLE device_binding_state(sn TEXT PRIMARY KEY,binding_policy TEXT,binding_version INTEGER);
 CREATE TABLE device_credential_revocation(sn TEXT PRIMARY KEY,not_before_sec INTEGER);
 CREATE TABLE ark_device_epoch(sn TEXT PRIMARY KEY,epoch INTEGER);`);
 devices.prepare('INSERT INTO device_registry VALUES(?,?,?,?,?,?,?)').run(SN,'dev_0123456789abcdef','legacy-device','legacy-parent','active','ble-key-v1',1);
 devices.prepare('INSERT INTO device_binding_state VALUES(?,?,?)').run(SN,'ble-key-v1',1);devices.prepare('INSERT INTO ark_device_epoch VALUES(?,?)').run(SN,2);
 ark.exec('CREATE TABLE ark_settings(id INTEGER PRIMARY KEY,enabled INTEGER);INSERT INTO ark_settings VALUES(1,1);CREATE TABLE ark_grant(sn TEXT PRIMARY KEY,account_id TEXT,epoch INTEGER,grant_id TEXT,not_before_ms INTEGER);');
 ark.prepare('INSERT INTO ark_grant VALUES(?,?,?,?,?)').run(SN,'legacy-device',2,grant,NOW-7*86400000);
 const scope={sn:SN,public_id:'dev_0123456789abcdef',account_id:'legacy-device',parent_account_id:'legacy-parent',binding_version:1,epoch:2,grant_id:grant,save_ids:'*'};
 process.env.ARK_RECORDS_LEGACY_SCOPE_JSON=JSON.stringify(scope);
 const store=new RecordsStore({arkPath,devicesPath,allowed:sn=>sn===SN,validAccount:()=>true,secret:()=> 'synthetic-legacy-summary'});
 const credential={sn:SN,iat:NOW/1000,exp:NOW/1000+3600,bindingVersion:1};
 t.after(()=>{store.close();devices.close();ark.close();delete process.env.ARK_RECORDS_LEGACY_SCOPE_JSON;});
 const legacy=(r:ReturnType<typeof record>)=>{const parsed=LegacyRecordSchema.parse(r);const result=store.acceptLegacy(credential,store.preflightLegacy(credential,r.save_id),{save_id:r.save_id,coverage_from_ms:DAY-86400000,dropped_records:0},parsed);assert.equal(result,'accepted');return parsed;};
 const v1=(save:string,seq:number,at:number,item:string,patch:Record<string,unknown>={})=>{
  const r=RecordSchema.parse({record_id:`v1-${save}-${seq}`,save_id:save,sequence:seq,origin_grant_id:grant,origin_epoch:2,occurred_at_ms:at,time_quality:'reported',logical_day:'2026-11-15',source_mode:'normal',reason:'reward_claim',business_source_id:`source-${save}-${seq}`,tank_id:null,stage_id:null,
   resource_changes:[],item_changes:[{operation:'acquired',item_instance_id:`instance-${item}`,item_id:item,item_kind:'tank_component',quantity:1,state:'pending_activation'}],...patch});
  assert.equal(store.accept(credential,store.preflight(credential,[]),r),'accepted');return r;
 };
 return {store,devices,ark,scope,credential,legacy,v1,summary:()=>store.dashboard(scope.public_id,scope.parent_account_id)};
}
const item=(id:string,status='pending_activation',quantity=1)=>({item_id:id,kind:'ecotank_part',quantity,tank_id:'tank-1',layer:'base',status,acquired_at_ms:DAY+1000});
const reward=(id='reward-1',coin=7,patch:Record<string,unknown>={})=>({reward_instance_id:id,source_kind:'daily_gift',source_id:'gift-1',logical_day:'2026-10-01',config_revision:'rev',status:'granted',granted_at_ms:DAY+1000,
 resolved_rewards:[{kind:'currency',item_id:'C-FAMILY-001',quantity:coin,tank_id:null,layer:null}],...patch});
function record(sequence=1,patch:Record<string,unknown>={}){return {record_id:`save-legacy:${sequence}`,save_id:'save-legacy',sequence,occurred_at_ms:DAY+1000*sequence,logical_day:'2026-10-01',source_mode:'normal',record_kind:'business_commit',config_revision:'rev',active_ecotank_id:null,
 data:{wallet_changes:[{resource_id:'C-FAMILY-001',before:0,after:7,delta:7}],inventory_changes:[] as any[],grants:[reward()] as any[],makeup_grants:[] as any[],makeup_uses:[] as any[],previous_source_mode:'normal'},...patch};}
function gain(save:string,seq:number,at:number,id:string,source_mode='normal'){
 const r=record(seq,{save_id:save,record_id:`${save}:${seq}`,occurred_at_ms:at,source_mode});r.data.wallet_changes=[];r.data.grants=[];r.data.inventory_changes=[{item_id:id,before:null,after:item(id)}];return r;
}

test('legacy grant income uses actual commit day, missing currency null, and baseline never earns',t=>{
 const f=fixture(t);f.legacy(record());
 const b=record(2,{record_kind:'baseline',data:{wallet:{'C-FAMILY-001':9000,'C-STARDUST-001':100},inventory:[item('old')],history_complete_before_baseline:false}});f.legacy(b);
 const d=f.summary();assert.equal(d.yesterday_income.available,true);assert.equal(d.yesterday_income.family_coin,7);assert.equal(d.yesterday_income.stardust,null);assert.equal(d.yesterday_income.occurred_from_ms,DAY+1000);assert.equal(d.latest_items.available,false);
 assert.equal(d.coverage.last_received_at_ms,NOW);
});

test('Shanghai midnight income uses commit wall clock instead of request grant time or target day',t=>{
 const f=fixture(t),today=DAY+86400000;
 for(const [seq,commitAt,grantAt,amount] of [[1,today, today-1,7],[2,today-1,today,7],[3,DAY,DAY-1,3],[4,DAY-1,DAY,11]]){
  const r=record(seq,{occurred_at_ms:commitAt,logical_day:'2020-01-01'});r.data.grants=[reward(`boundary-${seq}`,amount,{granted_at_ms:grantAt,logical_day:'2020-01-01'})];
  r.data.wallet_changes=[{resource_id:'C-FAMILY-001',before:0,after:amount,delta:amount}];f.legacy(r);
 }
 const d=f.summary().yesterday_income;assert.equal(d.family_coin,10);assert.equal(d.occurred_from_ms,DAY);assert.equal(d.occurred_to_ms,today-1);
});

test('out-of-order duplicate grant retains earliest sequence commit date when older history arrives',t=>{
 const f=fixture(t);f.legacy(record(20,{occurred_at_ms:DAY+86400000+1000}));assert.equal(f.summary().yesterday_income.available,false);
 f.legacy(record(10,{occurred_at_ms:DAY+2000}));let d=f.summary().yesterday_income;assert.equal(d.family_coin,7);assert.equal(d.occurred_from_ms,DAY+2000);
 f.legacy(record(30,{occurred_at_ms:DAY+86400000+2000}));d=f.summary().yesterday_income;assert.equal(d.family_coin,7);assert.equal(d.occurred_to_ms,DAY+2000);
});

test('earliest sequence wins even when later duplicate has a backwards clock in yesterday',t=>{
 const f=fixture(t);f.legacy(record(2,{occurred_at_ms:DAY+2000}));assert.equal(f.summary().yesterday_income.family_coin,7);
 f.legacy(record(1,{occurred_at_ms:DAY+86400000+1000}));assert.equal(f.summary().yesterday_income.available,false);assert.equal(f.summary().yesterday_income.family_coin,null);
});

test('later duplicate cannot replace the earliest sequence failed wallet reconciliation',t=>{
 const f=fixture(t);f.legacy(record(2));assert.equal(f.summary().yesterday_income.family_coin,7);
 const earliest=record(1);earliest.data.wallet_changes=[{resource_id:'C-FAMILY-001',before:0,after:5,delta:5}];f.legacy(earliest);
 assert.equal(f.summary().yesterday_income.available,false);assert.equal(f.summary().yesterday_income.family_coin,null);
});

test('same grant in multiple immutable records counts once, conflicting unknown/GM evidence invalidates it',t=>{
 const f=fixture(t);f.legacy(record(1));f.legacy(record(2));assert.equal(f.summary().yesterday_income.family_coin,7);
 const bad=record(3,{source_mode:'unknown'});bad.data.grants=[reward('reward-1',8)];bad.data.wallet_changes=[{resource_id:'C-FAMILY-001',before:0,after:8,delta:8}];f.legacy(bad);
 const d=f.summary().yesterday_income;assert.equal(d.available,false);assert.equal(d.family_coin,null);assert.equal(d.reason,'conflicting_reward');
});

test('v1 income combines with eligible legacy grants but never with baseline, GM or raw delta alone',t=>{
 const f=fixture(t);f.legacy(record(1));const unclassified=record(2);unclassified.data.grants=[];f.legacy(unclassified);
 f.legacy(record(3,{source_mode:'gm',data:{...record().data,grants:[reward('gm-2')]}}));
 f.v1('v1',1,DAY+5000,'unused',{item_changes:[],resource_changes:[{resource_id:'stardust',before:null,after:null,delta:4}]});
 const d=f.summary().yesterday_income;assert.equal(d.family_coin,7);assert.equal(d.stardust,4);assert.equal(d.occurred_to_ms,DAY+5000);
});

test('latest legacy acquisition projects later activation without creating another gain',t=>{
 const f=fixture(t);const a=gain('save-a',2,DAY+2000,'part');f.legacy(a);
 const activation=record(3,{save_id:'save-a',record_id:'save-a:3',occurred_at_ms:DAY+3000});activation.data.wallet_changes=[];activation.data.grants=[];activation.data.inventory_changes=[{item_id:'part',before:item('part'),after:item('part','active')}];f.legacy(activation);
 const d=f.summary().latest_items;assert.equal(d.available,true);assert.equal(d.record_id,'save-a:2');assert.equal(d.items.length,1);assert.equal(d.items[0].quantity,1);assert.equal(d.items[0].state,'active');assert.equal(d.items[0].activation_record_id,'save-a:3');
});

test('legacy aggregate item activation cannot activate v1 instances; only an exact v1 reference can',t=>{
 const f=fixture(t),acquired=f.v1('shared',1,DAY+1000,'unused',{item_changes:['instance-a','instance-b'].map(id=>({operation:'acquired',item_instance_id:id,item_id:'shared-item',item_kind:'tank_component',quantity:1,state:'pending_activation'}))});
 const activation=record(2,{save_id:'shared',record_id:'shared:2'});activation.data.wallet_changes=[];activation.data.grants=[];
 activation.data.inventory_changes=[{item_id:'shared-item',before:item('shared-item','pending_activation',2),after:item('shared-item','active',2)}];f.legacy(activation);
 assert.deepEqual(f.summary().latest_items.items.map(i=>[i.state,i.activation_record_id]),[['pending_activation',null],['pending_activation',null]]);
 const precise=f.v1('shared',3,DAY+3000,'unused',{reason:'item_activation',item_changes:[{operation:'activated',item_instance_id:'instance-a',acquired_record_id:acquired.record_id,state:'active'}]});
 assert.deepEqual(f.summary().latest_items.items.map(i=>[i.state,i.activation_record_id]),[['active',precise.record_id],['pending_activation',null]]);
});

test('newer GM/unknown legacy acquisition cannot resurrect an older normal acquisition',t=>{
 const f=fixture(t);f.v1('older',1,DAY+1000,'old');f.legacy(gain('new',1,DAY+2000,'new','unknown'));
 const d=f.summary().latest_items;assert.equal(d.available,false);assert.equal(d.reason,'non_normal');assert.deepEqual(d.items,[]);
});

test('unknown legacy acquisition clock suppresses misleading latest selection',t=>{
 const f=fixture(t);f.v1('older',1,DAY+1000,'old');f.legacy(gain('new',1,0,'new'));
 const d=f.summary().latest_items;assert.equal(d.available,false);assert.equal(d.reason,'clock_unknown');
});

test('choose largest sequence per save across formats before comparing clocks across saves',t=>{
 const f=fixture(t);f.v1('save-a',3,DAY+13000,'a3');f.v1('save-b',1,DAY+12000,'b1');f.legacy(gain('save-a',4,DAY+11000,'a4'));
 const d=f.summary().latest_items;assert.equal(d.available,true);assert.equal(d.record_id,'v1-save-b-1');assert.equal(d.items[0].item_id,'b1');
});

test('legacy newer sequence wins over later-clock v1 acquisition in the same save',t=>{
 const f=fixture(t);f.v1('same',1,DAY+9000,'first');f.legacy(gain('same',2,DAY+1000,'second'));
 const d=f.summary().latest_items;assert.equal(d.record_id,'same:2');assert.equal(d.items[0].item_id,'second');
});

test('grant with missing inventory gain stays unavailable rather than falling back',t=>{
 const f=fixture(t);f.legacy(gain('old',1,DAY+1000,'old'));const r=record(1,{save_id:'new',record_id:'new:1',occurred_at_ms:DAY+9000});
 r.data.wallet_changes=[];r.data.grants=[reward('part',1,{resolved_rewards:[{kind:'ecotank_part',item_id:'part',quantity:1,tank_id:'tank-1',layer:'base'}]})];f.legacy(r);
 const d=f.summary().latest_items;assert.equal(d.available,false);assert.equal(d.reason,'unverified_acquisition');
});

test('revoked legacy scope hides income and acquisition and foreign parent remains not_enabled',t=>{
 const f=fixture(t);f.legacy(record());f.legacy(gain('items',1,DAY+9000,'part'));
 delete process.env.ARK_RECORDS_LEGACY_SCOPE_JSON;assert.equal(f.summary().yesterday_income.available,false);assert.equal(f.summary().latest_items.available,false);
 const d=f.store.dashboard(f.scope.public_id,'foreign');assert.equal(d.yesterday_income.reason,'not_enabled');
});

test('a later makeup-card grant is a resource and does not hide the latest acquired component',t=>{
 const f=fixture(t);f.legacy(gain('same',1,DAY+1000,'component'));
 const card=gain('same',2,DAY+2000,'M-CARD-001');card.data.inventory_changes[0].after.kind='makeup_card';f.legacy(card);
 const d=f.summary().latest_items;assert.equal(d.available,true);assert.equal(d.record_id,'same:1');assert.equal(d.items[0].item_id,'component');
});
