import {readFileSync} from 'node:fs';
const requireFile=()=>readFileSync(new URL('../src/analytics/event-property-schema-v1.json',import.meta.url),'utf8');
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {AnalyticsStore} from '../src/analytics/store.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';
import {readArkHistory} from '../src/ark/history.js';
const NOW=Date.parse('2026-10-31T09:00:00Z'),KEY='a'.repeat(64),OTHER='a'.repeat(12)+'b'.repeat(52);
function fixture(){const root=mkdtempSync(join(tmpdir(),'ark-history-')),store=new AnalyticsStore(join(root,'analytics.db'));let seq=0;
 const add=(name:string,properties:Record<string,unknown>,occurred=NOW-1000,received=NOW,key=KEY)=>{const id='e'+(++seq);const ack=settleAnalyticsBatch(store,{deviceKey:key,active:true,uploadEnabled:true,uploadHourCst:23},{schema_version:1,batch_id:'b'+seq,sent_at_ms:received,client:{content_version:'test-content'},events:[{schema_version:1,client_event_id:id,event_name:name,occurred_at_ms:occurred,session_id:'s',sequence:seq,priority:'normal',context:{},properties}]},'r'+seq,received);assert.equal(ack.rejected.length,0);};
 const normal=(at=NOW-2000)=>add('g1.logical_day_changed',{previous_logical_day:'2026-10-30',logical_day:'2026-10-31',previous_usage_day_index:1,usage_day_index:2,gm_override:false},at);
 const wallet=(n:number,at=NOW-1000,received=NOW,key=KEY)=>add('g1.wallet_balance_changed',{item_id:'C-FAMILY-001',before:0,after:n,delta:n},at,received,key);
 return {store,add,normal,wallet,done(){store.close();rmSync(root,{recursive:true,force:true});}};
}
test('history keeps unknown distinct from zero and never uses a 12-character alias',()=>{const f=fixture();try{
 f.normal();f.wallet(99,NOW-1000,NOW,OTHER);assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).status,'unknown');
 f.wallet(0);const h=readArkHistory(f.store,KEY,NOW-5000,NOW);assert.equal(h.wallets.family_coin?.value,0);assert.equal(h.wallets.stardust,null);
}finally{f.done();}});
test('latest value uses event occurrence time, not delayed batch receipt or sum(delta)',()=>{const f=fixture();try{f.normal();f.wallet(8,NOW-800,NOW);f.wallet(3,NOW-900,NOW+500);const h=readArkHistory(f.store,KEY,NOW-5000,NOW+500);assert.equal(h.wallets.family_coin?.value,8);assert.equal(h.wallets.family_coin?.content_version,'test-content');}finally{f.done();}});
test('historical ownership watermark and suspicious clocks are fail-closed',()=>{const f=fixture();try{f.normal();f.wallet(8);assert.equal(readArkHistory(f.store,KEY,NOW-500,NOW).wallets.family_coin,null);f.wallet(9,NOW+10000);assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).wallets.family_coin?.value,8);}finally{f.done();}});
test('GM marker poisons logical day, absent marker is unknown, truncated never yields a balance',()=>{const f=fixture();try{
 f.wallet(9);assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).wallets.family_coin,null);
 f.normal();f.add('g1.wallet_balance_changed',{truncated:true},NOW-10);assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).wallets.family_coin?.value,9);
 f.add('g1.logical_day_changed',{previous_logical_day:'2026-10-30',logical_day:'2026-10-31',previous_usage_day_index:1,usage_day_index:2,gm_override:true},NOW-1);
 assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).status,'unknown');
}finally{f.done();}});
test('retention and query limit cannot turn partial unknown history into confident facts',()=>{const f=fixture();try{f.normal();f.wallet(7);assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW+15*86400000).status,'unknown');for(let i=0;i<513;i++)f.wallet(i,NOW-900+i);assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).wallets.family_coin?.value,512);}finally{f.done();}});
test('known inventory uses absolute quantity; unknown asset IDs never leak',()=>{const f=fixture();try{f.normal();f.add('g1.inventory_changed',{item_id:'M-CARD-001',before_quantity:99,quantity:0,delta:-99,status:'active',tank_id:'',layer:''});f.add('g1.inventory_changed',{item_id:'UNVERIFIED',before_quantity:0,quantity:999,delta:999,status:'active',tank_id:'',layer:''});const h=readArkHistory(f.store,KEY,NOW-5000,NOW);assert.equal(h.inventory['M-CARD-001']?.value,0);assert.doesNotMatch(JSON.stringify(h),/UNVERIFIED|999/);}finally{f.done();}});
test('same occurrence-time conflicting absolute values are unknown, never resolved by upload order',()=>{const f=fixture();try{f.normal();f.wallet(8,NOW-1000,NOW);f.wallet(9,NOW-1000,NOW+1);assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW+1).wallets.family_coin,null);}finally{f.done();}});
test('truncated or impossible receipt-time normal markers cannot authorize later unmarked facts',()=>{const f=fixture();try{f.normal();f.wallet(5);f.store.db.prepare("UPDATE analytics_event SET properties_json=json_set(properties_json,'$.truncated',json('true')) WHERE event_name='g1.logical_day_changed'").run();assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).status,'unknown');}finally{f.done();}});
test('GM evidence before the authorization watermark and with future clock still excludes its logical day',()=>{for(const at of [NOW-86400000,NOW+600000]){const f=fixture();try{f.add('g1.logical_day_changed',{previous_logical_day:'2026-10-30',logical_day:'2026-10-31',previous_usage_day_index:1,usage_day_index:2,gm_override:true},at);f.normal();f.wallet(12);assert.equal(readArkHistory(f.store,KEY,NOW-3000,NOW).status,'unknown');}finally{f.done();}}});

test('thousands of unrelated valid events cannot hide wallet state or GM veto',()=>{const f=fixture();try{f.normal();f.wallet(21);const e=f.store.db.prepare('SELECT * FROM analytics_event LIMIT 1').get() as any;const insert=f.store.db.prepare('INSERT INTO analytics_event VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');f.store.transaction(()=>{for(let i=0;i<3000;i++)insert.run(KEY,'noise'+i,'voice.session_state_changed',NOW-500,NOW,'s',i,'normal','{}','{}',e.batch_attempt_id,'2026-10-31','2026-10-31',0);});assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).wallets.family_coin?.value,21);f.add('g1.logical_day_changed',{previous_logical_day:'2026-10-30',logical_day:'2026-10-31',previous_usage_day_index:1,usage_day_index:2,gm_override:true},NOW-1);assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).status,'unknown');}finally{f.done();}});

test('uppercase and slash-separated GM source tokens veto normal-day history',()=>{for(const source of ['GM','gm/debug','foo+DEBUG','TEST@tool']){const f=fixture();try{f.normal();f.wallet(31);const catalog=JSON.parse(requireFile()).events;const event=catalog.find((e:any)=>e.eventName==='g1.reward_granted');f.add(event.eventName,{...event.sample,source_kind:source});assert.equal(readArkHistory(f.store,KEY,NOW-5000,NOW).status,'unknown',source);}finally{f.done();}}});
