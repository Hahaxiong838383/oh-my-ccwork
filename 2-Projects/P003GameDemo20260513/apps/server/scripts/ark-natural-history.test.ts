import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AnalyticsStore} from '../src/analytics/store.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';
import {readArkHistory} from '../src/ark/history.js';
import {resolveArkFacts} from '../src/ark/context.js';
import {answerArk} from '../src/ark/answer.js';
import {isArkStateQuestion,answerArkResourceUse} from '../src/xiaoke-kb.js';
const now=Date.parse('2026-11-15T12:00:00+08:00'),key='a'.repeat(64),other='b'.repeat(64);
const catalog=JSON.parse(readFileSync(new URL('../src/analytics/event-property-schema-v1.json',import.meta.url),'utf8')).events;
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ark-natural-')),store=new AnalyticsStore(join(dir,'a.db'));let seq=0;
 function add(name:string,props:Record<string,unknown>,at=now-1000,k=key){const n=++seq;const properties={...catalog.find((x:any)=>x.eventName===name).sample,...props};
  const ack=settleAnalyticsBatch(store,{deviceKey:k,active:true,uploadEnabled:true,uploadHourCst:23},{schema_version:1,batch_id:'b'+n,sent_at_ms:now,client:{content_version:'fixture-v'},events:[{schema_version:1,client_event_id:'e'+n,event_name:name,occurred_at_ms:at,session_id:'s',sequence:n,priority:'normal',context:{},properties}]},'r'+n,now);assert.equal(ack.rejected.length,0,name);
 }
 const normal=()=>add('g1.logical_day_changed',{logical_day:'2026-11-15',previous_logical_day:'2026-11-14',gm_override:false},now-4000);
 const history=(watermark=now-5000)=>readArkHistory(store,key,watermark,now);
 return {add,normal,history,done(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('accepted stardust and dedicated card balance are readable and independently selected',()=>{const f=fixture();try{
 f.normal();f.add('g1.wallet_balance_changed',{item_id:'C-FAMILY-001',before:0,after:999,delta:999});
 f.add('g1.wallet_balance_changed',{item_id:'C-STARDUST-001',before:0,after:42,delta:42});
 f.add('g1.makeup_card_balance_changed',{before:0,after:3,delta:3});
 const h=f.history();assert.equal(h.wallets.stardust?.value,42);assert.equal(h.inventory['M-CARD-001']?.value,3);
 const facts=resolveArkFacts({snapshot:null,history:h},now);
 assert.match(answerArk('我还有多少星尘',facts,[],now)??'',/星尘余额是42/);
 assert.match(answerArk('我有几张补勤卡',facts,[],now)??'',/补勤卡库存是3张/);
 assert.doesNotMatch(answerArk('我还有多少星尘',facts,[],now)??'',/999|家族币/);
}finally{f.done();}});
test('new readers preserve real zero, ownership watermark, full device identity and source veto',()=>{for(const mode of ['normal','missing','gm','old','other']){const f=fixture();try{
 if(mode!=='missing')f.normal();
 f.add('g1.wallet_balance_changed',{item_id:'C-STARDUST-001',before:4,after:0,delta:-4},now-1000,mode==='other'?other:key);
 f.add('g1.makeup_card_balance_changed',{before:2,after:0,delta:-2},now-1000,mode==='other'?other:key);
 if(mode==='gm')f.add('g1.logical_day_changed',{logical_day:'2026-11-15',gm_override:true},now-500);
 const h=f.history(mode==='old'?now-500:now-5000);
 assert.equal(h.wallets.stardust?.value??null,mode==='normal'?0:null,mode);
 assert.equal(h.inventory['M-CARD-001']?.value??null,mode==='normal'?0:null,mode);
}finally{f.done();}}});
test('same-time conflict across dedicated/general inventory and stardust never uses upload order',()=>{const f=fixture();try{
 f.normal();f.add('g1.makeup_card_balance_changed',{before:0,after:3,delta:3});
 f.add('g1.inventory_changed',{item_id:'M-CARD-001',before_quantity:0,quantity:4,delta:4});
 f.add('g1.wallet_balance_changed',{item_id:'C-STARDUST-001',before:0,after:7,delta:7});
 f.add('g1.wallet_balance_changed',{item_id:'C-STARDUST-001',before:0,after:8,delta:8});
 assert.equal(f.history().wallets.stardust,null);assert.equal(f.history().inventory['M-CARD-001'],null);
}finally{f.done();}});
test('daily answer selects exactly requested resource, never wallet or another reward',()=>{const f=fixture();try{
 f.normal();f.add('g1.reward_granted',{logical_day:'2026-11-15',reward_instance_id:'grant1',source_kind:'progress_stage',source_id:'REGULAR-01',rewards:[{kind:'currency',item_id:'C-FAMILY-001',quantity:20,tank_id:''},{kind:'currency',item_id:'C-STARDUST-001',quantity:5,tank_id:''},{kind:'item',item_id:'M-CARD-001',quantity:1,tank_id:''}]});
 const facts=resolveArkFacts({snapshot:null,history:f.history()},now);
 for(const [q,yes,no] of [['今天获得多少星尘',/星尘5/,/家族币20|补勤卡1/],['今天获得几张补勤卡',/补勤卡1张/,/家族币20|星尘5/],['今天获得多少金币',/家族币20枚/,/星尘5|补勤卡1/]] as const){const reply=answerArk(q,facts,[],now)??'';assert.match(reply,yes,q);assert.doesNotMatch(reply,no,q);}
 assert.match(answerArk('今天收益有哪些',facts,[],now)??'',/家族币20枚.*星尘5.*补勤卡1张/);
 assert.match(answerArk('今天使用了多久，获得了多少收益',facts,[],now)??'',/家族币20枚/);
}finally{f.done();}});
test('natural reward questions actually pass static shortcut and ask facts; outside topics stay chat',()=>{
 for(const q of ['还有未领取的奖励吗','有没有没领的奖励','我还有奖励没领吗','下一个奖励还需要多久','下一项奖励是什么','下一次奖励还差多久','今天收益','今天收益有哪些','今天获得了什么奖励','今天使用了多久，获得了多少收益','补勤卡可以补哪一天','补勤卡能补10月30日吗']){
  assert.equal(isArkStateQuestion(q),true,q);assert.equal(answerArkResourceUse(q),null,q);assert.ok(answerArk(q,undefined,[],now),q);
 }
 for(const q of ['今天股票收益有哪些','今天老师给我什么奖励','下一个比赛奖励是什么','有没有未领取的外卖','公司还有未领取的奖励吗','订阅奖励提醒','原神今天收益有哪些','我喜欢奖励','明天会下雨吗'])assert.equal(isArkStateQuestion(q),false,q);
});
test('no eligibility/price data is not guessed from the card count or static knowledge',()=>{
 assert.match(answerArk('补勤卡能补10月30日吗',undefined,[],now)??'',/可补日期.*查不到|查不到.*可补日期/);
 assert.doesNotMatch(answerArk('补勤卡能补10月30日吗',undefined,[],now)??'',/可以补10月30日|不能补10月30日/);
});
test('new readers use latest occurrence, ignore future rows and do not sum deltas',()=>{const f=fixture();try{
 f.normal();f.add('g1.wallet_balance_changed',{item_id:'C-STARDUST-001',before:42,after:7,delta:-35},now-500);
 f.add('g1.wallet_balance_changed',{item_id:'C-STARDUST-001',before:0,after:42,delta:42},now-900);
 f.add('g1.wallet_balance_changed',{item_id:'C-STARDUST-001',before:7,after:999,delta:992},now+60000);
 f.add('g1.makeup_card_balance_changed',{before:3,after:2,delta:-1},now-500);
 f.add('g1.inventory_changed',{item_id:'M-CARD-001',before_quantity:0,quantity:3,delta:3},now-900);
 assert.equal(f.history().wallets.stardust?.value,7);assert.equal(f.history().inventory['M-CARD-001']?.value,2);
}finally{f.done();}});
test('natural next reward uses fresh facts, expired facts cannot report countdown',()=>{
 const facts:any={schema_version:1,assets:{family_coin:null,stardust:null,makeup_card:null},progress:{captured_at_ms:now,received_at_ms:now,logical_day:'2026-11-15',timer_state:'running',status:'locked',kind:'chest',item_id:null,remaining_seconds:120,claimable_count:2}};
 for(const q of ['还有未领取的奖励吗','下一个奖励还需要多久','下一项奖励是什么']){
  const reply=answerArk(q,facts,[],now)??'';assert.match(reply,/宝箱/);assert.match(reply,/2分钟/);assert.match(reply,/2项未领取/);
  const stale=answerArk(q,facts,[],now+30001)??'';assert.match(stale,/查不到/);assert.doesNotMatch(stale,/2项|2分钟/);
 }
});
test('sharing a reward experience stays conversation, not a personal data query',()=>{
 for(const q of ['今天收获很多，我很开心','今天收益不错','我终于把未领取的奖励都领完了']){
  assert.equal(isArkStateQuestion(q),false,q);assert.equal(answerArk(q),null,q);
 }
});
test('question particles belong to the reward clause, not narrative adverbs or another clause',()=>{
 for(const q of ['今天收益这么好','今天收获这么多，我很开心','我还有点开心，今天收益不错','今天收益不错呢','我这么开心，终于把未领取的奖励都领完了','那么今天收益不错','今天收益不错，还有什么好玩的']){
  assert.equal(isArkStateQuestion(q),false,q);assert.equal(answerArk(q),null,q);
 }
 for(const q of ['今天收益怎样','今天收益如何','今天的收益呢','今天收益不错吗'])assert.equal(isArkStateQuestion(q),true,q);
});
