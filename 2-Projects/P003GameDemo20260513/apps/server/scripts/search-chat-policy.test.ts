import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchChatPolicy } from '../src/tools/search-chat-policy.js';
const input={candidate:true,enabled:true,role:'device',room:'sn-BJP00326060100100004-1',allowed:['BJP00326060100100004']};
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
