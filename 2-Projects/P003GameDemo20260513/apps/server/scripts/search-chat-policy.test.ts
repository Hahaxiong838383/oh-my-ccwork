import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchChatPolicy } from '../src/tools/search-chat-policy.js';
const input={candidate:true,enabled:true,role:'device',room:'sn-BJP00326060100100004-1',allowed:['BJP00326060100100004']};
test('R22 explanation questions and inline quotes retain their meaning across stream chunks',()=>{
 for(const text of ['你想让我查资料吗？','你希望小可帮你查询什么？','如果我查到相关资料，你希望听哪部分？','你说“我去查一下”是什么意思？','比如“我正在查询”是一种说法。']){
  for(let size=1;size<=text.length;size++){
   const f=policy.createSearchClaimFilter(true);let out='';
   for(let i=0;i<text.length;i+=size)out+=f.feed(text.slice(i,i+size));
   assert.equal(out+f.flush(),text,`chunk ${size}: ${text}`);
  }
 }
});
test('R22 a quote or question does not exempt a later execution claim',()=>{
 for(const prefix of ['你说“我去查一下”是什么意思？','你想让我查资料吗？','“我去查一下”，','"我去查一下。"']){
  const f=policy.createSearchClaimFilter(true);let out='';
  for(const c of prefix+'我已经查到了最新消息。')out+=f.feed(c);
  out+=f.flush();assert.ok(out.startsWith(prefix),out);assert.ok(!out.includes('查到了最新消息'),out);
 }
});
test('R22 search-term explanations are bounded and do not consume named queries',()=>{
 const explain=(policy as any).searchTermExplanation;assert.equal(typeof explain,'function');
 for(const text of ['查查是啥','搜索是什么意思','小可，查查这个词啥意思？','请帮我查一下是什么意思']){
  const reply=explain(text);assert.equal(typeof reply,'string');assert.match(reply,/资料/);assert.ok(reply.length<50);assert.doesNotMatch(reply,/请说|具体问题|正在|已经/);
 }
 for(const text of ['帮我查查光合作用是啥','搜索深空探测是干什么的','我想查个东西','不要查查是啥','如果我说查查是啥呢'])assert.equal(explain(text),null,text);
});
test('search chat capabilities and onboarding suppression apply only to active candidate device',()=>{
 assert.equal(searchChatPolicy(input).suppressOnboarding,true);
 assert.ok(searchChatPolicy(input).instruction.length>0);
 for(const patch of [{candidate:false},{enabled:false},{role:'parent'},{room:'sn-BJP00326070803800006-1'},{allowed:[]}]){
  assert.deepEqual(searchChatPolicy({...input,...patch}),{suppressOnboarding:false,instruction:''});
 }
});

import * as policy from '../src/tools/search-chat-policy.js';
test('unconfirmed search promises cannot escape through SSE chunk boundaries',()=>{
 const factory=(policy as any).createSearchClaimFilter;
 assert.equal(typeof factory,'function','candidate output needs a deterministic execution-claim guard');
 for(const claim of ['我帮你查查北京今天的天气，稍等一下哦。','小可帮你看看最新新闻，稍等一下。','我正在搜索恐龙的资料。','我已经查到了，票价是20元。','搜索已经完成了。','查到啦！','我，帮你在网上查询一下。','我没有查到相关资料。']){
  for(let split=0;split<=claim.length;split++){
   const guard=factory(true);const out=guard.feed(claim.slice(0,split))+guard.feed(claim.slice(split))+guard.flush();
   assert.notEqual(out,claim,claim);assert.ok(out.includes('具体问题'),out);
  }
 }
});
test('ordinary chat and advice keep their wording and production streams stay immediate',()=>{
 const factory=(policy as any).createSearchClaimFilter;assert.equal(typeof factory,'function');
 for(const text of ['你可以在博物馆官网查询开放时间。','恐龙生活在很久以前。','“搜索”就是查找资料。','我们继续聊你画的小猫吧。']){
  const guard=factory(true);assert.equal(guard.feed(text)+guard.flush(),text);
 }
 const production=factory(false);assert.equal(production.feed('我帮你查'), '我帮你查');assert.equal(production.flush(),'');
});
test('claim guard is bounded and suppresses repeated false confirmations',()=>{
 const factory=(policy as any).createSearchClaimFilter;assert.equal(typeof factory,'function');
 const guard=factory(true);const out=guard.feed('我帮你查查新闻。正在搜索。')+guard.flush();assert.equal(out.split('具体问题').length-1,1);
 const long=factory(true);const text='我'.repeat(513);assert.ok(long.feed(text).length>0,'never buffer an unbounded model sentence');
});

test('R7 capability sanitizer removes only the obsolete denial inside active candidate',()=>{
 const fn=(policy as any).searchCapabilityBase;assert.equal(typeof fn,'function');
 const base='【真实性】只引用真实状态，查不到就说"小可还查不到呢，等我长大一些试试看！"。不要编造。';
 assert.equal(fn(base,false),base);assert.ok(!fn(base,true).includes('等我长大'));assert.ok(fn(base,true).includes('不要编造'));
 for(const t of ['小可这会儿还查不到实时天气呢，等我长大一些试试看！','我还没法查到实时天气。']){const f=(policy as any).createSearchClaimFilter(true);const out=f.feed(t)+f.flush();assert.ok(!out.includes('长大')&&!out.includes('没法'),out);}
});

test('safe ordinary clauses reach TTS at its existing sentence boundaries',()=>{
 for(const end of ['；',';','…','~','～']) {
  const f=policy.createSearchClaimFilter(true);
  const first=`调节温度要先看刻度${end}`;
  assert.equal(f.feed(first),first,`must not delay a speakable ${end} clause`);
  assert.equal(f.feed('再按说明书操作。'),'再按说明书操作。');
 }
});

test('early clause release retains split-token execution protection',()=>{
 for(const end of ['；',';','…','~','～']) {
  const sentence=`我帮你查询${end}`;
  for(let i=0;i<=sentence.length;i++) {
   const f=policy.createSearchClaimFilter(true);
   const out=f.feed(sentence.slice(0,i))+f.feed(sentence.slice(i))+f.flush();
   assert.ok(!out.includes('我帮你查询'));
  }
 }
 const f=policy.createSearchClaimFilter(true);
 assert.equal(f.feed('我，帮你'),'');
 assert.ok(!f.feed('查询。').includes('我，帮你查询'));
});

test('R17 ordinary content streams before sentence end even when the input contains weather or temperature',()=>{
 for(const chunks of [
  ['烤箱温度要看食谱，','先找对应的温度刻度。'],
  ['天气变化和空气流动有关，','冷热空气会影响天气。'],
  ['树叶中有叶绿素，','它能帮助植物利用阳光。'],
 ]){
  const f=policy.createSearchClaimFilter(true);
  assert.equal(f.feed(chunks[0]),chunks[0],'safe first clause must reach the existing Worker segmenter immediately');
  assert.equal(f.feed(chunks[1])+f.flush(),chunks[1]);
 }
});

test('R17 a later execution claim is withheld without withholding an earlier safe clause',()=>{
 for(const claim of ['我，帮你查询天气。','小可已经搜索到了。','搜索已经完成了。','我现在暂时没有搜索能力。','等我长大再说。']){
  for(let split=0;split<=claim.length;split++){
   const f=policy.createSearchClaimFilter(true);const safe='先聊聊可爱的小猫，';assert.equal(f.feed(safe),safe);
   const out=f.feed(claim.slice(0,split))+f.feed(claim.slice(split))+f.flush();
   assert.ok(out.includes('具体问题'),claim);assert.ok(!out.includes('查询天气')&&!out.includes('搜索到了')&&!out.includes('搜索能力')&&!out.includes('长大'),out);
  }
 }
});

test('R17 safe streaming and filtering are independent of provider chunk sizes',()=>{
 const safe=['你可以在官网查询开放时间。','恐龙生活在很久以前。','“我帮你查询”是一个例句。','大家喜欢小猫，当然也喜欢小狗。','我们继续聊你画的小猫吧。','小孩子喜欢画画。'];
 const claims=['我帮你查天气。','我现在帮你在网上查询。','我暂时还没法查到天气。','稍等一下哦。','请稍等。','等我长大一些。','正在帮你搜索。','查询已经失败。'];
 for(const text of [...safe,...claims]){
  const full=policy.createSearchClaimFilter(true);const expected=full.feed(text)+full.flush();
  for(let size=1;size<=5;size++){
   const f=policy.createSearchClaimFilter(true);let out='';for(let i=0;i<text.length;i+=size)out+=f.feed(text.slice(i,i+size));out+=f.flush();assert.equal(out,expected,text);
  }
  if(safe.includes(text))assert.equal(expected,text);else assert.ok(expected.includes('具体问题'),text);
 }
});

test('R17 bounded denial lookahead and overlapping modifier tokens retain the existing claim grammar',()=>{
 for(const mods of ['','已经','刚刚','还没有','帮你在网上','马上'.repeat(6)]){
  for(const actor of ['我','小可']){
   const text=actor+mods+'查询天气。';const f=policy.createSearchClaimFilter(true);
   let out='';for(const char of text)out+=f.feed(char);out+=f.flush();assert.ok(out.includes('具体问题'),text);assert.ok(!out.includes('查询天气'),text);
  }
 }
 for(const gap of [0,1,17,18]){
  const text='我'+'很'.repeat(gap)+'没有搜索能力。';const f=policy.createSearchClaimFilter(true);
  let out='';for(const char of text)out+=f.feed(char);out+=f.flush();assert.ok(out.includes('具体问题'),text);assert.ok(!out.includes('没有搜索能力'),text);
 }
 const beyond='我'+'很'.repeat(19)+'没有搜索能力。';const g=policy.createSearchClaimFilter(true);
 assert.equal(g.feed(beyond)+g.flush(),beyond,'do not broaden the original bounded denial rule');
 const padded=policy.createSearchClaimFilter(true);const result=padded.feed('我'+' '.repeat(513)+'帮你查询天气。')+padded.flush();
 assert.ok(result.includes('具体问题'));assert.ok(!result.includes('查询天气'));
});
