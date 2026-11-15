import {test} from 'node:test';
import assert from 'node:assert/strict';
import {answerArk} from '../src/ark/answer.js';
import {answerArkResourceUse,buildKnowledgeRecall,isArkStateQuestion} from '../src/xiaoke-kb.js';
import {resolveArkQuestion} from '../src/ark/memory-policy.js';
const now=Date.parse('2026-11-15T14:00:00+08:00');
const user=(content:string)=>({role:'user',content});
const f:any={schema_version:1,assets:{family_coin:{value:990,occurred_at_ms:now,received_at_ms:now,content_version:'test'},stardust:null,makeup_card:{value:1,occurred_at_ms:now,received_at_ms:now,content_version:'test'}},progress:{captured_at_ms:now,received_at_ms:now,logical_day:'2026-11-15',timer_state:'running',status:'claimable',kind:'currency',item_id:'C-FAMILY-001',remaining_seconds:0,claimable_count:2}};
test('user-approved complete ASR aliases explain makeup card and family currency',()=>{
 for(const name of ['捕禽卡','古琴卡','抚琴弹','抚琴卡','补签卡']){assert.match(answerArk(name+'有什么用',f,[],now)??'',/补勤卡.*补签/,name);assert.match(answerArk('我有多少'+name,f,[],now)??'',/库存是1张/,name);assert.equal(isArkStateQuestion('我有多少'+name),true);}
 assert.match(answerArk('加组币有什么用',f,[],now)??'',/家族币.*小程序/);
 for(const q of ['不行卡','文章捕'])assert.equal(answerArkResourceUse(q),null);
});
test('incomplete card names require confirmation, not inventory disclosure',()=>{
 for(const q of ['我有多少行卡','我还有几张仙卡']){const a=answerArk(q,f,[],now)??'';assert.match(a,/你说的是补勤卡吗/);assert.doesNotMatch(a,/1张|库存是/);}
});
test('claim followups fetch progress and cannot pretend to execute or expose a shop',()=>{
 const h=[user('金币可以换什么'),{role:'assistant',content:'错误历史：我给你换好了'}];
 for(const q of ['好你帮我','换换快点换','我点哪里']){assert.ok(resolveArkQuestion(q,h),q);assert.equal(answerArkResourceUse(q,h),null,q);const a=answerArk(q,f,h,now)??'';assert.match(a,/2项/);assert.match(a,/点.*进度条|进度条.*点/);assert.match(a,/不能.*代|不能.*替/);assert.doesNotMatch(a,/换好了|领好了|自动到账/);}
 assert.match(answerArk('展示出来',f,h,now)??'',/当前.*不支持|目前.*不能/);
 assert.match(answerArk('咱俩',f,[user('家族币是我和你约定的奖励')],now)??'',/你和我/);
});
test('today earned uses deduplicated awards, not wallet; progress explains remaining effective time',()=>{
 const daily={logical_day:'2026-11-15',received_at_ms:now,observed_at_ms:now,coverage:'received_records',progress_seconds:600,rewards:[{item_id:'C-FAMILY-001',quantity:20},{item_id:'M-CARD-001',quantity:1}]};
 const a=answerArk('我今天获得多少金币',{...f,daily},[],now)??'';assert.match(a,/20枚家族币|家族币20枚/);assert.match(a,/有效使用|有效专注/);assert.doesNotMatch(a,/990|赚了0/);
 const b=answerArk('今天方舟进展怎么样',{...f,daily},[],now)??'';assert.match(b,/10分钟/);assert.match(b,/补勤卡1张|1张补勤卡/);assert.match(b,/奖励进度/);
 const locked={...f,progress:{...f.progress,status:'locked',claimable_count:0,remaining_seconds:120}};
 const c=answerArk('下次奖励怎么拿',locked,[],now)??'';assert.match(c,/2分钟/);assert.match(c,/点亮/);assert.match(c,/点击|点.*领取/);
 assert.match(answerArk('我在读写台前待这么久为什么不给我加',f,[],now)??'',/领取|奖励进度/);
});

test('unfinished sentences stay conversational; control tag filtering handles all split boundaries',async()=>{
 const {unfinishedUtterance,createArkControlFilter,arkConversationPolicy}=await import('../src/ark/language.js');
 for(const q of ['小可我现在有','请问','请告诉','方舟里的补','方舟里的补勤','文章捕']){assert.equal(unfinishedUtterance(q),true,q);assert.match(arkConversationPolicy(q,[]),/不要结束/);assert.equal(answerArk(q,f,[],now),null,q);}
 for(const q of ['退下','关灯','不想聊了','退出倾听恢复聊天','我现在有多少金币'])assert.equal(unfinishedUtterance(q),false,q);
 const str='[[DEV:90]]你继续说，我在听。';for(let i=0;i<=str.length;i++){const filter=createArkControlFilter(true);assert.equal(filter.feed(str.slice(0,i))+filter.feed(str.slice(i))+filter.flush(),'你继续说，我在听。');}
 const filter=createArkControlFilter(false);assert.equal(filter.feed('[[DEV:3]]关灯')+filter.flush(),'[[DEV:3]]关灯');
});
