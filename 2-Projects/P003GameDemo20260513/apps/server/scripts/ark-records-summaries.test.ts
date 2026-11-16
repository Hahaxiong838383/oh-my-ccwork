/** Synthetic records in temporary SQLite only. No production state or credentials. */
import {test, after, mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const YESTERDAY = Date.parse('2026-11-14T16:00:00Z');
const TODAY = Date.parse('2026-11-15T16:00:00Z');
mock.timers.enable({apis: ['Date'], now: NOW});
const root = mkdtempSync(join(tmpdir(), 'ark-summaries-'));
process.chdir(root);
for (const key of ['DEVICES','ACCOUNTS','ARK']) process.env[`${key}_DB_PATH`] = join(root, `${key}.db`);
process.env.AUTH_JWT_SECRET = 'synthetic-summary-tests';
process.env.ARK_CONTEXT_SN_ALLOW = '';
process.env.ARK_RECORDS_SN_ALLOW = '';
process.env.ARK_RECORDS_MIN_FREE_BYTES = '1';
for (const key of ['UPLOAD_PER_MINUTE','UPLOAD_PER_HOUR','GLOBAL_UPLOAD_PER_MINUTE','GLOBAL_UPLOAD_PER_HOUR']) process.env[`ARK_RECORDS_${key}`] = '10000';
const {deviceRegistryStore: registry} = await import('../src/device-registry-store.js');
const {accountStore} = await import('../src/account-store.js');
const {arkStore} = await import('../src/ark/service.js');
const {recordsStore} = await import('../src/ark/records-service.js');
const {RecordSchema,canonical} = await import('../src/ark/records-contract.js');
const store = recordsStore();
after(() => { store.close(); mock.timers.reset(); });
let serial = 0;
function fixture() {
  const sn = `BJP003260601${String(++serial).padStart(8, '0')}`, owner = `summary-parent-${serial}`;
  registry.add(sn, 'synthetic'); registry.setParentAccountId(sn, owner);
  registry.setAccountId(sn, accountStore.createDeviceAccount(sn, 'synthetic').id);
  process.env.ARK_CONTEXT_SN_ALLOW += `,${sn}`; process.env.ARK_RECORDS_SN_ALLOW += `,${sn}`;
  arkStore().authorize(registry.arkIdentity(sn)!, NOW - 7 * 86400000);
  const grant = arkStore().grant(registry.arkIdentity(sn)!)!;
  const credential = {sn, iat: NOW / 1000, exp: NOW / 1000 + 3600};
  return {sn, owner, grant, credential, pub: registry.get(sn)!.public_id!};
}
type F = ReturnType<typeof fixture>;
function record(f: F, id: string, sequence: number, patch: Record<string, unknown> = {}) {
  return RecordSchema.parse({record_id: id, save_id: 'save1', sequence,
    origin_grant_id: f.grant.grant_id, origin_epoch: f.grant.epoch,
    occurred_at_ms: YESTERDAY + sequence * 1000, time_quality: 'reported', logical_day: '2026-11-01',
    source_mode: 'normal', reason: 'reward_claim', business_source_id: `business-${id}`, tank_id: null, stage_id: null,
    resource_changes: [{resource_id: 'family_coin', delta: 2, before: null, after: null}], item_changes: [], ...patch});
}
function put(f: F, id: string, sequence: number, patch: Record<string, unknown> = {}) {
  const r = record(f, id, sequence, patch);
  assert.equal(store.accept(f.credential, store.preflight(f.credential, []), r), 'accepted');
  return r;
}
const summary = (f: F) => store.dashboard(f.pub, f.owner);
const acquired = (id: string, patch: Record<string, unknown> = {}) => ({operation: 'acquired', item_instance_id: id,
  item_id: 'component', item_kind: 'tank_component', quantity: 1, state: 'pending_activation', ...patch});
const activation = (target: string, item: string, patch: Record<string, unknown> = {}) => ({reason: 'item_activation', resource_changes: [],
  item_changes: [{operation: 'activated', acquired_record_id: target, item_instance_id: item, state: 'active'}], ...patch});

// Catches inventing a zero income / full history from an empty data set.
test('empty summaries are unavailable with null amounts and no_records', () => {
  const f = fixture(), d = summary(f);
  assert.equal(d.yesterday_income.reason, 'no_records'); assert.equal(d.yesterday_income.available, false);
  assert.equal(d.yesterday_income.family_coin, null); assert.equal(d.yesterday_income.stardust, null);
  assert.equal(d.latest_items.reason, 'no_records'); assert.deepEqual(d.latest_items.items, []);
  assert.equal(d.updated_at_ms, null); assert.equal(d.coverage.complete, false);
});

// Catches using logical_day, UTC boundaries, or net balance instead of actual reward receipts.
test('yesterday sums positive normal rewards at Shanghai day boundaries without netting spending', () => {
  const f = fixture();
  put(f, 'before', 1, {occurred_at_ms: YESTERDAY - 1});
  put(f, 'start', 2, {occurred_at_ms: YESTERDAY, resource_changes: [{resource_id:'family_coin',delta:7,before:null,after:null}]});
  put(f, 'end', 3, {occurred_at_ms: TODAY - 1, reason: 'tank_unlock', resource_changes: [
    {resource_id:'family_coin',delta:5,before:null,after:null},{resource_id:'stardust',delta:9,before:null,after:null}]});
  put(f, 'today', 4, {occurred_at_ms: TODAY});
  put(f, 'spent', 5, {reason: 'resource_spend', resource_changes: [{resource_id:'family_coin',delta:-8,before:null,after:null}]});
  put(f, 'gm', 6, {source_mode: 'gm'});
  put(f, 'unknown-source', 7, {source_mode: 'unknown'});
  put(f, 'unknown-time', 8, {occurred_at_ms: null, time_quality: 'unknown'});
  put(f, 'bad-clock', 9, {occurred_at_ms: NOW + 3600000});
  const d = summary(f).yesterday_income;
  assert.equal(d.available, true); assert.equal(d.reason, 'partial_history'); assert.equal(d.source_mode, 'normal');
  assert.equal(d.date, '2026-11-15'); assert.equal(d.timezone, 'Asia/Shanghai');
  assert.equal(d.family_coin, 12); assert.equal(d.stardust, 9);
  assert.equal(d.occurred_from_ms, YESTERDAY); assert.equal(d.occurred_to_ms, TODAY - 1); assert.equal(d.received_at_ms, NOW);
});

// Catches counting a missing currency as a measured zero, or double counting a duplicate upload.
test('one observed currency leaves the other null and immutable replay never increases income', () => {
  const f = fixture(), r = put(f, 'dust', 1, {resource_changes: [{resource_id:'stardust',delta:4,before:null,after:null}]});
  assert.equal(store.accept(f.credential, store.preflight(f.credential, []), r), 'duplicate');
  const d = summary(f).yesterday_income;
  assert.equal(d.available, true); assert.equal(d.family_coin, null); assert.equal(d.stardust, 4);
});

// Catches treating current-day receipt time as the income day for late uploads.
test('late receipt is attributed to occurrence day and no positive matching currency stays unavailable', () => {
  const f = fixture();
  put(f, 'card', 1, {resource_changes: [{resource_id:'M-CARD-001',delta:1,before:null,after:null}]});
  assert.equal(summary(f).yesterday_income.available, false);
  assert.equal(summary(f).yesterday_income.reason, 'no_records');
  put(f, 'late', 2, {occurred_at_ms: YESTERDAY + 1234});
  assert.equal(summary(f).yesterday_income.family_coin, 2);
  assert.equal(summary(f).yesterday_income.received_at_ms, NOW);
});

// Catches truncating a valid multi-record sum to the per-record quantity bound.
test('income aggregates safely above a single record quantity maximum', () => {
  const f = fixture();
  for (let n = 1; n <= 2; n++) put(f, `large-${n}`, n, {resource_changes:[{resource_id:'family_coin',delta:1000000000,before:null,after:null}]});
  assert.equal(summary(f).yesterday_income.family_coin, 2000000000);
});

// Catches filtering to one save/tank or splitting a multi-item transaction.
test('latest acquired transaction spans saves and tanks and returns its whole pending group', () => {
  const f = fixture();
  put(f, 'older', 1, {item_changes:[acquired('old')]});
  put(f, 'newer', 1, {save_id:'save2',tank_id:'tank2',occurred_at_ms:TODAY,
    item_changes:[acquired('part'),acquired('hat',{item_kind:'avatar_decoration',quantity:2})]});
  const d = summary(f).latest_items;
  assert.equal(d.available,true); assert.equal(d.reason,'partial_history'); assert.equal(d.source_mode,'normal');
  assert.equal(d.record_id,'newer'); assert.equal(d.save_id,'save2'); assert.equal(d.occurred_at_ms,TODAY);
  assert.deepEqual(d.items.map(x=>[x.item_instance_id,x.quantity,x.state,x.activation_record_id]),
    [['part',1,'pending_activation',null],['hat',2,'pending_activation',null]]);
});

// Catches receipt-order sorting and non-deterministic same-time selection.
test('backfilled older acquisitions do not replace latest and equal-time ordering matches records page', () => {
  const f = fixture();
  put(f,'newer',3,{occurred_at_ms:TODAY,item_changes:[acquired('new')]});
  put(f,'older',1,{item_changes:[acquired('old')]});
  put(f,'same-time',2,{occurred_at_ms:TODAY,item_changes:[acquired('tie')]});
  assert.equal(summary(f).latest_items.record_id,'newer');
});

// Catches a backwards device clock overriding the authoritative business sequence within a save.
test('same-save sequence wins over a backwards acquisition clock', () => {
  const f=fixture();
  put(f,'seq1',1,{occurred_at_ms:NOW-1000,item_changes:[acquired('first')]});
  put(f,'seq2',2,{occurred_at_ms:NOW-2000,item_changes:[acquired('second')]});
  const d=summary(f).latest_items;
  assert.equal(d.available,true); assert.equal(d.record_id,'seq2');
  assert.equal(d.items[0].item_instance_id,'second');
});

// Catches a non-normal latest business operation being hidden by a slightly earlier device time.
test('same-save latest non-normal sequence cannot fall back through a backwards clock', () => {
  for(const source_mode of ['gm','unknown']) {
    const f=fixture();
    put(f,'seq1',1,{occurred_at_ms:NOW-1000,item_changes:[acquired('first')]});
    put(f,'seq2',2,{occurred_at_ms:NOW-2000,source_mode,item_changes:[acquired('second')]});
    const d=summary(f).latest_items;
    assert.equal(d.available,false); assert.equal(d.reason,'non_normal'); assert.equal(d.record_id,null);
  }
});

// Catches skipping an unsafe latest acquisition and falling back to an older normal item.
test('latest non-normal acquisition blocks fallback to older normal', () => {
  for (const source_mode of ['gm','unknown']) {
    const f=fixture(); put(f,'normal',1,{item_changes:[acquired('normal')]});
    put(f,'unsafe',2,{source_mode,item_changes:[acquired('unsafe')]});
    const d=summary(f).latest_items;
    assert.equal(d.available,false); assert.equal(d.reason,'non_normal'); assert.equal(d.record_id,null); assert.deepEqual(d.items,[]);
  }
});

// Catches claiming chronological latest when an acquisition's clock is not usable.
test('unknown or suspect acquisition time blocks a chronological latest claim', () => {
  for (const patch of [{occurred_at_ms:null,time_quality:'unknown'},{occurred_at_ms:NOW+3600000}]) {
    const f=fixture(); put(f,'known',1,{item_changes:[acquired('known')]});
    put(f,'uncertain',2,{...patch,item_changes:[acquired('uncertain')]});
    const d=summary(f).latest_items;
    assert.equal(d.available,false); assert.equal(d.reason,'clock_unknown'); assert.deepEqual(d.items,[]);
  }
});

// Catches treating activation as a new reward or failing to resolve out-of-order delivery.
test('normal activation updates the matching instance without adding quantities or income', () => {
  const f=fixture(); put(f,'activate',2,activation('acquire','part'));
  put(f,'acquire',1,{item_changes:[acquired('part'),acquired('hat',{item_kind:'avatar_decoration',quantity:2})]});
  const d=summary(f);
  assert.equal(d.latest_items.record_id,'acquire'); assert.equal(d.yesterday_income.family_coin,2);
  assert.deepEqual(d.latest_items.items.map(x=>[x.item_instance_id,x.quantity,x.state,x.activation_record_id]),
    [['part',1,'active','activate'],['hat',2,'pending_activation',null]]);
  assert.equal(store.page(f.pub,f.owner,{limit:20}).items.find(x=>x.record_id==='acquire')!.item_changes[0].state,'pending_activation');
});

// Catches GM/unknown clocks falsely activating normal objects.
test('non-normal or unclocked activations never change an acquired item state', () => {
  for (const patch of [{source_mode:'gm'},{source_mode:'unknown'},{occurred_at_ms:null,time_quality:'unknown'},{occurred_at_ms:NOW+3600000}]) {
    const f=fixture(); put(f,'acquire',1,{item_changes:[acquired('part')]});
    put(f,'activate',2,activation('acquire','part',patch));
    assert.equal(summary(f).latest_items.items.length,1);
    assert.equal(summary(f).latest_items.items[0].state,'pending_activation');
    assert.equal(summary(f).latest_items.items[0].activation_record_id,null);
  }
});

// Catches including another owner's or previous grant's reward in summaries.
test('summaries never cross parent identity or a new ownership generation', () => {
  const f=fixture(); put(f,'private',1,{item_changes:[acquired('part')]});
  assert.equal(store.dashboard(f.pub,'other-parent').yesterday_income.available,false);
  registry.setParentAccountId(f.sn,'new-parent'); arkStore().authorize(registry.arkIdentity(f.sn)!,NOW);
  const next=store.dashboard(f.pub,'new-parent');
  assert.equal(next.yesterday_income.reason,'no_records'); assert.equal(next.latest_items.reason,'no_records');
  assert.equal(next.updated_at_ms,null);
});

// Catches materializing repeated full activation bodies and holding the shared SQLite lock too long.
test('32-item summary stays bounded near capacity with a thousand repeated activation references', () => {
  const f=fixture(), ids=Array.from({length:32},(_,n)=>`item-${n}-`+'x'.repeat(60));
  put(f,'acquire',1,{item_changes:ids.map(id=>acquired(id))});
  const activationPatch={reason:'item_activation',resource_changes:[],item_changes:ids.map(item_instance_id=>
    ({operation:'activated',item_instance_id,acquired_record_id:'acquire',state:'active'}))};
  put(f,'activate-0',2,activationPatch);
  // This case measures reads. Validate shapes and seed equivalent rows in one temporary-DB transaction,
  // preserving real constraints/reference indexes/usage triggers without thousands of unrelated fsyncs.
  const account=store.db.prepare('SELECT origin_device_account_id FROM ark_record WHERE sn=? AND record_id=?').get(f.sn,'acquire')!.origin_device_account_id;
  const insert=store.db.prepare(`INSERT INTO ark_record(sn,record_id,save_id,sequence,origin_parent_account_id,origin_device_account_id,
    origin_epoch,origin_grant_id,reason,business_source_id,body,payload_bytes,received_at_ms,time_status,sort_ms,occurred_day)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'reported',?,'2026-11-15')`);
  const resource=store.db.prepare('INSERT INTO ark_record_resource VALUES(?,?,?)');
  const item=store.db.prepare('INSERT INTO ark_record_item VALUES(?,?,?,?,?,?)');
  const seed=(r:ReturnType<typeof record>)=>{
    const body=canonical(r);
    insert.run(f.sn,r.record_id,r.save_id,r.sequence,f.owner,account,r.origin_epoch,r.origin_grant_id,r.reason,
      r.business_source_id,body,Buffer.byteLength(body),NOW,r.occurred_at_ms);
    for(const x of r.resource_changes)resource.run(f.sn,r.record_id,x.resource_id);
    for(const x of r.item_changes)item.run(f.sn,r.record_id,r.save_id,x.item_instance_id,x.operation,x.operation==='activated'?x.acquired_record_id:null);
  };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for(let n=1;n<1000;n++)seed(record(f,`activate-${n}`,n+2,activationPatch));
    for(let n=0;n<8000;n++)seed(record(f,`income-${n}`,n+1002));
    store.db.exec('COMMIT');
  } catch(e) { store.db.exec('ROLLBACK'); throw e; }
  const before=process.memoryUsage(),start=performance.now(),d=summary(f),elapsed=performance.now()-start,after=process.memoryUsage();
  console.log('SUMMARY_FANOUT',JSON.stringify({records:9001,items:32,elapsed_ms:elapsed,heap_delta:after.heapUsed-before.heapUsed}));
  assert.equal(d.latest_items.record_id,'acquire'); assert.equal(d.latest_items.items.length,32);
  assert.ok(d.latest_items.items.every(x=>x.state==='active'&&x.activation_record_id==='activate-999'));
  assert.equal(d.yesterday_income.family_coin,16002);
  assert.ok(after.heapUsed-before.heapUsed<32*1024*1024,'summary must not materialize repeated large bodies');
  assert.ok(elapsed<750,'summary must not hold the shared write lock for a second');
});
