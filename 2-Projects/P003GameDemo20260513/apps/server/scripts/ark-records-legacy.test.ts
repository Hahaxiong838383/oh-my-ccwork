/** Synthetic fixtures only. Never send these records to a production device/API.
 * runtime fixture is the actual mini009 Rust serializer test output from
 * 006ac68a29447e8bc14fb655206d87bbf1f771a3, not a customer record. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LEGACY_CONTRACT, LegacyRecordSchema, parseLegacyBatch, projectLegacyRecord,
 legacyIncomeGrants, legacyActivations, legacyHasAcquisition} from '../src/ark/records-legacy.js';
import {canonical} from '../src/ark/records-contract.js';

const runtime = JSON.parse(readFileSync(new URL('./fixtures/ark-records-mini009-runtime.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-16T04:00:00Z');
const clone = <T>(v:T):T => JSON.parse(JSON.stringify(v));
function batch(records:any[]=clone(runtime.records)) {
 return {schema_version:1,contract_id:LEGACY_CONTRACT,batch_id:'synthetic-batch',save_id:records[0].save_id,
  coverage_from_ms:NOW,dropped_records:0,records};
}
function commit(patch:Record<string,unknown>={}) {
 return {...clone(runtime.records[1]),occurred_at_ms:NOW,...patch};
}
function inventory(patch:Record<string,unknown>={}) {
 return {item_id:'PART-1',kind:'ecotank_part',quantity:1,tank_id:'TANK-1',layer:'base',status:'pending_activation',acquired_at_ms:NOW,...patch};
}
function grant(id='reward-1',item='C-FAMILY-001',quantity=12,patch:Record<string,unknown>={}) {
 return {reward_instance_id:id,source_kind:'daily_gift',source_id:'gift-1',logical_day:'2026-11-01',status:'granted',
  config_revision:'rev-1',granted_at_ms:NOW,resolved_rewards:[{kind:'currency',item_id:item,quantity,tank_id:null,layer:null}],...patch};
}
function parsed(value:any) { return LegacyRecordSchema.parse(value); }

test('actual mini009 serializer fixture parses without mutating original facts',()=>{
 const wire=batch(),before=canonical(wire),b=parseLegacyBatch(wire);
 assert.equal(b.records.length,2);assert.equal(b.contract_id,LEGACY_CONTRACT);
 for(const x of b.records){assert.equal(x.parsed.success,true);if(x.parsed.success)assert.equal(canonical(x.parsed.data),canonical(x.raw));}
 assert.equal(canonical(wire),before);
 // The fixture's unclassified wallet increase is not invented reward income.
 assert.deepEqual(legacyIncomeGrants(parsed(wire.records[1])),[]);
});

test('envelope contract, duplicates, and unknown fields are rejected explicitly',()=>{
 for(const wire of [{...batch(),contract_id:'unknown'},{...batch(),extra:true},batch([runtime.records[0],runtime.records[0]])])
  assert.throws(()=>parseLegacyBatch(wire),e=>!!e&&typeof e==='object'&&'status'in e&&e.status===400);
});

test('batch, record, depth and array bounds hold before canonicalization',()=>{
 assert.throws(()=>parseLegacyBatch(batch(Array.from({length:17},(_,i)=>({...runtime.records[0],record_id:`${runtime.save_id}:${i+1}`,sequence:i+1})))),/batch_too_large/);
 assert.throws(()=>parseLegacyBatch({...batch(),batch_id:'x'.repeat(70000)}),/batch_too_large/);
 const huge=commit();huge.data.inventory_changes=Array.from({length:90},(_,i)=>({item_id:`part-${i}`,before:null,after:inventory({item_id:`part-${i}`,layer:'x'.repeat(256)})}));
 assert.throws(()=>parseLegacyBatch(batch([huge])),/record_too_large/);
 const deep=commit();let nested:any={};deep.data.extra=nested;for(let i=0;i<30;i++){nested.next={};nested=nested.next;}
 assert.throws(()=>parseLegacyBatch(batch([deep])),/invalid_envelope/);
 const tooMany=commit();tooMany.data.grants=Array.from({length:257},(_,i)=>grant(`r${i}`));
 assert.equal(LegacyRecordSchema.safeParse(tooMany).success,false);
});

test('legacy IDs up to 96 characters survive without truncation',()=>{
 const save='s'.repeat(94),r=commit({save_id:save,record_id:`${save}:2`});
 const b=parseLegacyBatch(batch([r]));assert.equal(b.records[0].parsed.success,true);
 assert.equal(projectLegacyRecord(parsed(r)).record_id.length,96);
});

test('malformed records remain per-ID errors, exact ID namespace and safe integers are checked',()=>{
 for(const patch of [{sequence:1.5},{occurred_at_ms:Number.MAX_SAFE_INTEGER+1},{record_id:`${runtime.save_id}:99`},{save_id:'other'}, {data:{...commit().data,secret:'not-allowed'}}]){
  const wire=batch([commit(patch)]);wire.save_id=runtime.save_id;
  const b=parseLegacyBatch(wire);assert.equal(b.records[0].parsed.success,false);
 }
});

test('wallet differences must be exact, and nested Runtime objects reject unknown fields',()=>{
 const r=commit();r.data.wallet_changes[0].delta=13;assert.equal(LegacyRecordSchema.safeParse(r).success,false);
 r.data.wallet_changes[0].delta=12;r.data.grants=[grant()];r.data.grants[0].resolved_rewards[0].token='bad';
 assert.equal(LegacyRecordSchema.safeParse(r).success,false);
});

test('baseline projects existing balances and items without any acquisition or income',()=>{
 const raw=clone(runtime.records[0]);raw.data.wallet={'C-FAMILY-001':80};raw.data.inventory=[inventory()];
 const r=parsed(raw),p=projectLegacyRecord(r);
 assert.equal(p.format,LEGACY_CONTRACT);assert.equal(p.authorization_source,'legacy_explicit_scope');assert.equal(p.origin_verified,false);
 assert.equal('origin_epoch'in p,false);assert.equal('origin_grant_id'in p,false);
 assert.deepEqual(p.resource_changes,[]);assert.deepEqual(p.item_changes,[]);
 assert.deepEqual(p.baseline?.wallets,{family_coin:80,stardust:null,'M-CARD-001':null});
 assert.equal(p.baseline?.items[0].state,'pending_activation');
 assert.equal(legacyHasAcquisition(r),false);assert.deepEqual(legacyIncomeGrants(r),[]);
});

test('multiple reward grants reconcile against a single wallet change without double counting',()=>{
 const r=commit();r.data.grants=[grant('g1','C-FAMILY-001',5),grant('g2','C-FAMILY-001',7),grant('g3','C-STARDUST-001',3)];
 r.data.wallet_changes.push({resource_id:'C-STARDUST-001',before:6,after:9,delta:3});
 const income=legacyIncomeGrants(parsed(r));
 assert.equal(income.reduce((n,g)=>n+(g.family_coin??0),0),12);assert.equal(income.reduce((n,g)=>n+(g.stardust??0),0),3);
 assert.equal(income[0].occurred_at_ms,NOW);assert.equal(income[0].fingerprint.length,64);
 assert.equal(projectLegacyRecord(parsed(r)).reason,'reward_claim');
});

test('unknown source or mismatched currency cannot wash a wallet increase into income',()=>{
 const r=commit();r.data.grants=[grant('known','C-FAMILY-001',5),grant('unknown','C-FAMILY-001',7,{source_kind:'unrecognized'})];
 assert.deepEqual(legacyIncomeGrants(parsed(r)),[]);
 r.data.grants=[grant('coin','C-FAMILY-001',11),grant('dust','C-STARDUST-001',3)];
 r.data.wallet_changes.push({resource_id:'C-STARDUST-001',before:0,after:3,delta:3});
 const income=legacyIncomeGrants(parsed(r));assert.equal(income.length,1);assert.equal(income[0].family_coin,null);assert.equal(income[0].stardust,3);
});

test('the Runtime legacy coin reward alias reconciles to its actual family wallet',()=>{
 const r=commit();r.data.grants=[grant('old-coin','C-COIN-001',12)];
 const income=legacyIncomeGrants(parsed(r));assert.equal(income.length,1);assert.equal(income[0].family_coin,12);
});

test('negative mixed netting, GM, unknown and invalid commit clocks do not count as normal income',()=>{
 const r=commit();r.data.grants=[grant()];
 for(const source_mode of ['gm','unknown'])assert.deepEqual(legacyIncomeGrants(parsed({...r,source_mode})),[]);
 r.data.wallet_changes[0]={resource_id:'C-FAMILY-001',before:20,after:15,delta:-5};assert.deepEqual(legacyIncomeGrants(parsed(r)),[]);
 r.data.wallet_changes[0]={resource_id:'C-FAMILY-001',before:0,after:12,delta:12};r.occurred_at_ms=0;assert.deepEqual(legacyIncomeGrants(parsed(r)),[]);
});

test('income time comes from Runtime commit wall clock, never request grant time or historical target day',()=>{
 const r=commit();r.logical_day='2020-01-01';r.data.grants=[grant('historical','C-FAMILY-001',12,{granted_at_ms:0,logical_day:'2020-01-01'})];
 const before=canonical(r),income=legacyIncomeGrants(parsed(r));assert.equal(income.length,1);assert.equal(income[0].occurred_at_ms,NOW);
 assert.equal(canonical(r),before);assert.equal(r.data.grants[0].granted_at_ms,0);
});

test('duplicate grant, resource or inventory keys are malformed rather than double counted',()=>{
 const a=commit();a.data.grants=[grant(),grant()];assert.equal(LegacyRecordSchema.safeParse(a).success,false);
 const b=commit();b.data.wallet_changes.push(clone(b.data.wallet_changes[0]));assert.equal(LegacyRecordSchema.safeParse(b).success,false);
 const c=commit();c.data.inventory_changes=[{item_id:'PART-1',before:null,after:inventory()},{item_id:'PART-1',before:null,after:inventory()}];assert.equal(LegacyRecordSchema.safeParse(c).success,false);
});

test('new inventory quantity makes stable derived acquisition identities without requiring new wire fields',()=>{
 const r=commit();r.data.wallet_changes=[];r.data.grants=[grant('part-grant','PART-1',2,{resolved_rewards:[{kind:'ecotank_part',item_id:'PART-1',quantity:2,tank_id:'TANK-1',layer:'base'}]})];
 r.data.inventory_changes=[{item_id:'PART-1',before:inventory({quantity:1}),after:inventory({quantity:3})}];
 const p=projectLegacyRecord(parsed(r));assert.equal(p.item_changes.length,1);
 assert.equal(p.item_changes[0].operation,'acquired');assert.equal(p.item_changes[0].quantity,2);assert.equal(p.item_changes[0].item_kind,'tank_component');
 assert.equal(p.item_changes[0].item_identity_source,'legacy_derived');assert.equal(p.item_changes[0].item_instance_id,projectLegacyRecord(parsed(r)).item_changes[0].item_instance_id);
 assert.equal(legacyHasAcquisition(parsed({...r,source_mode:'unknown'})),true);
});

test('grant without a matching inventory increase remains a latest-candidate warning, not a fake acquisition',()=>{
 const r=commit();r.data.grants=[grant('part-grant','PART-1',1,{resolved_rewards:[{kind:'ecotank_part',item_id:'PART-1',quantity:1,tank_id:'TANK-1',layer:'base'}]})];
 assert.equal(legacyHasAcquisition(parsed(r)),true);assert.deepEqual(projectLegacyRecord(parsed(r)).item_changes,[]);
});

test('pending to active is a state change and never a second acquisition',()=>{
 const r=commit();r.data.wallet_changes=[];r.data.inventory_changes=[{item_id:'PART-1',before:inventory(),after:inventory({status:'active'})}];
 const p=projectLegacyRecord(parsed(r));assert.deepEqual(p.item_changes,[]);assert.equal(legacyHasAcquisition(parsed(r)),false);
 assert.deepEqual(legacyActivations(parsed(r)),[{item_id:'PART-1',state:'active'}]);
 assert.deepEqual(p.inventory_state_changes,[{item_id:'PART-1',from_state:'pending_activation',to_state:'active',quantity:1}]);
 assert.equal(p.reason,'item_activation');
});

test('unknown inventory kinds and wallet IDs survive but are not falsely mapped',()=>{
 const r=commit();r.data.wallet_changes.push({resource_id:'OTHER',before:1,after:2,delta:1});
 r.data.inventory_changes=[{item_id:'PART-1',before:null,after:inventory({kind:'future_kind'})}];
 const p=projectLegacyRecord(parsed(r));assert.equal(p.item_changes[0].item_kind,'unknown');
 assert.equal(p.resource_changes.length,1);assert.equal(p.unmapped_resource_changes[0].resource_id,'OTHER');
});

test('zero and out-of-range wall clocks are preserved as raw facts and projected unknown',()=>{
 for(const occurred_at_ms of [0,Number.MAX_SAFE_INTEGER]){
  const r=parsed(commit({occurred_at_ms})),p=projectLegacyRecord(r);assert.equal(r.occurred_at_ms,occurred_at_ms);
  assert.equal(p.occurred_at_ms,null);assert.equal(p.time_quality,'unknown');
 }
});

test('makeup-card baseline reads the actual inventory quantity and does not duplicate an item',()=>{
 const r=clone(runtime.records[0]);r.data.inventory=[inventory({item_id:'M-CARD-001',kind:'makeup_card',quantity:2,status:'active'})];
 const p=projectLegacyRecord(parsed(r));assert.equal(p.baseline?.wallets['M-CARD-001'],2);assert.deepEqual(p.baseline?.items,[]);
 r.data.wallet={'M-CARD-001':3};assert.equal(projectLegacyRecord(parsed(r)).baseline?.wallets['M-CARD-001'],null);
 r.data.wallet={'M-CARD-001':2};assert.equal(projectLegacyRecord(parsed(r)).baseline?.wallets['M-CARD-001'],2);
});

test('makeup-card inventory consumption projects one real resource delta',()=>{
 const r=commit();r.data.wallet_changes=[];r.data.grants=[];
 r.data.makeup_uses=[{tank_id:'TANK-1',logical_day:'2026-11-01',usage_day_index:1}];
 r.data.inventory_changes=[{item_id:'M-CARD-001',before:inventory({item_id:'M-CARD-001',kind:'makeup_card',quantity:2,status:'active'}),after:inventory({item_id:'M-CARD-001',kind:'makeup_card',quantity:1,status:'active'})}];
 const p=projectLegacyRecord(parsed(r));assert.deepEqual(p.resource_changes,[{resource_id:'M-CARD-001',before:2,after:1,delta:-1}]);assert.deepEqual(p.item_changes,[]);assert.equal(p.reason,'makeup_card_use');
 r.data.wallet_changes=[{resource_id:'M-CARD-001',before:2,after:1,delta:-1}];assert.equal(projectLegacyRecord(parsed(r)).resource_changes.length,1);
 r.data.wallet_changes=[{resource_id:'M-CARD-001',before:3,after:2,delta:-1}];assert.deepEqual(projectLegacyRecord(parsed(r)).resource_changes,[]);
});

test('new makeup cards are resources, never latest-item acquisition candidates',()=>{
 const r=commit();r.data.wallet_changes=[];r.data.grants=[grant('card','M-CARD-001',1,{resolved_rewards:[{kind:'makeup_card',item_id:'M-CARD-001',quantity:1,tank_id:null,layer:null}]})];
 r.data.inventory_changes=[{item_id:'M-CARD-001',before:null,after:inventory({item_id:'M-CARD-001',kind:'makeup_card',status:'active'})}];
 assert.equal(legacyHasAcquisition(parsed(r)),false);assert.deepEqual(projectLegacyRecord(parsed(r)).item_changes,[]);
 assert.deepEqual(projectLegacyRecord(parsed(r)).resource_changes,[{resource_id:'M-CARD-001',before:0,after:1,delta:1}]);
});
