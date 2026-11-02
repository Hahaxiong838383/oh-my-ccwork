import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../src/ark/context.js';
import {isArkStateQuestion} from '../src/xiaoke-kb.js';
const now=Date.parse('2026-11-02T17:00:00+08:00');
// Source fixture lives in the reviewed Android contract, never in production.
const sample=()=>({schema_version:1,snapshot_id:'test-1',captured_at_ms:now,boot_id:'boot-1',boot_started_at_ms:now-10000,sequence:1,logical_day:'2026-11-02',config_revision:'test-rule',content_version:'test-v',source_mode:'normal',wallets:{family_coin:0,stardust:7},inventory:{'M-CARD-001':3},progress:{timer_state:'paused',claimable_count:0,next_reward:{status:'locked',kind:'chest',item_id:null,stage_id:'s1',remaining_seconds:120}}} as const);
test('realistic quantity variants request current facts; external domains never do',()=>{
 for(const text of ['我有几枚金币','我有几张补勤卡','我有补勤卡吗','今天方舟收益怎么样','方舟进展怎么样'])assert.equal(isArkStateQuestion(text),true,text);
 for(const text of ['你好','原神金币有多少','天上的星辰有多少','比特币今天收益怎么样'])assert.equal(isArkStateQuestion(text),false,text);
});
test('resolved facts preserve zero, omit GM values, resolve conflicts and expire progress',()=>{
 const resolve=(context as any).resolveArkFacts;assert.equal(typeof resolve,'function');
 const current={snapshot:sample(),received_at_ms:now};
 const v=resolve({snapshot:current,history:null},now);assert.equal(v.assets.family_coin.value,0);assert.equal(v.progress.remaining_seconds,120);assert.equal(v.progress.timer_state,'paused');
 assert.equal(resolve({snapshot:current,history:null},now+30001).progress,null);
 const gm=resolve({snapshot:{...current,snapshot:{...sample(),source_mode:'gm'}},history:null},now);assert.equal(gm.assets.family_coin,null);assert.equal(gm.progress,null);assert.doesNotMatch(JSON.stringify(gm),/5200/);
 const history={ok:true,status:'available',reason:'none',wallets:{family_coin:{value:99,occurred_at_ms:now,received_at_ms:now,content_version:'v1'},stardust:null},inventory:{'M-CARD-001':null}};
 assert.equal(resolve({snapshot:current,history},now).assets.family_coin,null);
});
test('bounded factual answers do not invent game economics or turn balance into earnings',async()=>{
 const {answerArk}=await import('../src/ark/answer.js');
 const resolve=(context as any).resolveArkFacts;
 const facts=resolve({snapshot:{snapshot:sample(),received_at_ms:now},history:null},now);
 assert.match(answerArk('我现在有多少家族币',facts,[],now)!,/0/);
 assert.match(answerArk('我有几张补勤卡',facts,[],now)!,/3张/);
 assert.match(answerArk('我有补勤卡吗',facts,[],now)!,/3张/);
 assert.match(answerArk('我今天赚了多少家族币',facts,[],now)!,/今日收益.*查不到/);
 assert.doesNotMatch(answerArk('我今天赚了多少家族币',facts,[],now)!,/余额.*0/);
 assert.match(answerArk('我离下一个宝箱还需要多久',facts,[],now)!,/暂停/);
 assert.match(answerArk('我离下一个宝箱还需要多久',facts,[],now)!,/2分钟/);
 assert.doesNotMatch(answerArk('我离下一个宝箱还需要多久',facts,[],now)!,/自动到账|会来得更快|一定/);
 assert.match(answerArk('我有几枚金币',facts,[],now)!,/星尘.*家族币|家族币.*星尘/);
 assert.equal(answerArk('企鹅为什么不会飞',facts,[],now),null);
 assert.equal(answerArk('原神金币有什么用',facts,[],now),null);
 const use=answerArk('星尘有什么用',undefined,[],now)!;assert.match(use,/换装/);assert.doesNotMatch(use,/装饰|充能|帽子/);
 assert.match(answerArk('现在呢',facts,[{role:'user',content:'我现在有多少家族币'}],now)!,/0/);
 assert.match(answerArk('下一个宝箱还要多久',facts,[],now+30001)!,/暂时查不到/);
});

test('current complete questions and explicit resource choices do not inherit old intents',async()=>{
 const {answerArk}=await import('../src/ark/answer.js');
 const {isArkFollowup}=await import('../src/ark/memory-policy.js');
 const history=[{role:'user',content:'我今天赚了多少家族币'},{role:'assistant',content:'今日收益未知'}];
 assert.doesNotMatch(answerArk('那现在家族币余额有多少',undefined,history,now)!,/今日收益/);
 assert.match(answerArk('家族币',undefined,[{role:'user',content:'金币几枚'},{role:'assistant',content:'家族币还是星尘'}],now)!,/家族币余额.*查不到/);
 assert.match(answerArk('星尘',undefined,[{role:'user',content:'金币有什么用'},{role:'assistant',content:'家族币还是星尘'}],now)!,/换装/);
 for(const q of ['宇宙中有多少星辰','马里奥的金币有什么用','那现在原神金币还有多少','那现在股票收益多少']){
  assert.equal(answerArk(q,undefined,history,now),null);assert.equal(isArkFollowup(q,history),false);
 }
});

test('resource choice preserves earnings intent and outside-domain history resets followups',async()=>{
 const {answerArk}=await import('../src/ark/answer.js');const {isArkFollowup,stripArkDynamicTurns}=await import('../src/ark/memory-policy.js');
 const user=(content:string)=>({role:'user',content});
 assert.match(answerArk('家族币',undefined,[user('今天赚了多少金币')],now)!,/今日收益.*不能把钱包余额/);
 assert.equal(isArkFollowup('现在呢',[user('金币几枚'),user('家族币')]),true);
 const mixed=[user('家族币多少'),user('那现在原神金币多少')];
 assert.equal(isArkFollowup('还有多久',mixed),false);assert.equal(answerArk('还有多久',undefined,mixed,now),null);
 assert.deepEqual(stripArkDynamicTurns(mixed),[mixed[1]]);
});

test('main without optional callback key still requires original verified Worker and exact explicit scope',async()=>{
 const {arkDirectReplyAllowed}=await import('../src/ark/answer.js');const saved={...process.env};
 try{
 Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic',ARK_WORKER_ACCOUNT_ID:'worker',ARK_DIRECT_REPLY_SN_ALLOW:'BJP00399999999999901'});delete process.env.CUSTOM_LLM_API_KEY;delete process.env.ARK_FACTS_PROXY_URL;
 const room='sn-BJP00399999999999901-123';assert.equal(arkDirectReplyAllowed({accountId:'worker',role:'device'},room),true);
 for(const auth of [null,{accountId:'other',role:'device'},{accountId:'worker',role:'parent'}])assert.equal(arkDirectReplyAllowed(auth,room),false);
 for(const r of ['sn-BJP00399999999999902-123',room+'-extra'])assert.equal(arkDirectReplyAllowed({accountId:'worker',role:'device'},r),false);
 assert.equal(arkDirectReplyAllowed({accountId:'worker',role:'device'},room,true),false);
 process.env.ARK_FACTS_PROXY_URL='http://127.0.0.1:3001';assert.equal(arkDirectReplyAllowed({accountId:'worker',role:'device'},room),false);
 }finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
