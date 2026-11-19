import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {resolveClock,answerClock,stripClockTurns} from '../src/tools/clock-query.js';
const fixtures=JSON.parse(readFileSync(new URL('../../../../../docs/time-query-20261117/FIXTURES.json',import.meta.url),'utf8'));
for(const c of fixtures.cases)test(c.id+': '+c.text,()=>{
 const r=resolveClock(c.text,c.context??[]);
 if(['chat','not_clock','unsupported_alarm','weather'].includes(c.expected_route)){assert.equal(r,null);return;}
 assert.ok(r);assert.equal(r.kind,c.expected_route);
 for(const [k,v] of Object.entries(c.expected_slots??{}))if(k!=='candidates'&&k!=='place_label')assert.deepEqual((r as any)[k],v);
 const a=answerClock(r,fixtures.frozen_now_ms);if(c.expected_spoken)assert.equal(a,c.expected_spoken);if(c.expected_clarify)assert.equal(a,c.expected_clarify);
});
for(const text of ['北京现在几点开门','现在几点上课','几点开始下雨','我今天用了多久','今日奖励还差几分钟','我现在有几点积分','你说现在几点了是什么意思','告诉我现在几点开会','不要告诉我现在几点','纽约有什么好玩的','北京时间是什么意思'])test('negative '+text,()=>assert.equal(resolveClock(text),null));
test('unknown timezone does not default to Beijing',()=>assert.equal(resolveClock('火星现在几点')?.kind,'clarify_timezone'));
test('unrelated latest turn clears implicit followup',()=>assert.equal(resolveClock('那纽约呢',['现在几点','金币有什么用']),null));
test('midnight and cross-date',()=>{const r=resolveClock('上海现在几点')!;assert.match(answerClock(r,Date.parse('2026-11-16T16:00:00Z')),/零点整/);const n=resolveClock('纽约现在几点')!;assert.match(answerClock(n,Date.parse('2026-11-16T16:00:00Z')),/星期一/);});
test('DST uses IANA rules',()=>{const n=resolveClock('纽约现在几点')!;assert.match(answerClock(n,Date.parse('2026-07-01T12:00:00Z')),/八点整/);assert.match(answerClock(n,Date.parse('2026-01-01T12:00:00Z')),/七点整/);});

test('RTC history drops clock answers and timezone followups, preserves personal narrative',()=>{
 const h=[{role:'user',content:'今天是我的生日'},{role:'assistant',content:'生日快乐'},{role:'user',content:'现在几点了'},{role:'assistant',content:'现在是北京时间早上七点三十八分。'},{role:'user',content:'那纽约呢'},{role:'assistant',content:'纽约现在是傍晚六点三十八分，星期一。'},{role:'user',content:'我喜欢熊猫'},{role:'assistant',content:'熊猫真可爱'}];
 assert.deepEqual(stripClockTurns(h),[...h.slice(0,2),...h.slice(6)]);
});

for(const q of ['我想知道现在几点','能告诉我现在几点吗','麻烦问一下现在几点了','查一下北京时间','现在几点几分','现在纽约几点','北京时间现在几点','北京那边现在几点了','现在几點了'])test('natural variant '+q,()=>{const r=resolveClock(q);assert.equal(r?.kind,'clock');});
for(const q of ['告诉我一个故事现在几点','如果现在几点了你会怎么说','比如现在几点了','“现在几点了”','他说现在几点了','现在几点了是什么意思'])test('quoted or narrative '+q,()=>assert.equal(resolveClock(q),null));
for(const q of ['现在的时间','当前时间','此刻的时间','现在时间是多少','请告诉我当前的时间'])test('current time phrase '+q,()=>assert.deepEqual(resolveClock(q),{kind:'clock',iana:'Asia/Shanghai',place_label:'北京时间',requested:'time'}));

for(const q of ['今天的日期','今天是不是周末','帮我看现在几点','现在才几点呢就跟我说晚安','北京市现在几点','纽约市现在几点'])test('review natural '+q,()=>assert.equal(resolveClock(q)?.kind,'clock'));
for(const q of ['妈妈说现在几点了','爸爸说现在几点了','老师说现在几点','这是什么时间','昨天几点了','明天几点'])test('review narrative '+q,()=>assert.equal(resolveClock(q),null));
test('city clarification preserves date question',()=>{const r=resolveClock('纽约',['美国今天几号']);assert.equal(r?.kind,'clock');assert.equal(r?.kind==='clock'&&r.requested,'date');assert.match(answerClock(r!,1794872324023),/2026年11月16日/);});

// 2026-11-18: whole clock intents only; nouns ending in 时间 are not places.
for(const q of ['麻烦告诉我现在几点','你能告诉我现在几点吗','请你告诉我今天是几号','能不能帮我查一下纽约现在几点','帮我查一查北京时间'])test('polite clock '+q,()=>assert.equal(resolveClock(q)?.kind,'clock'));
for(const q of ['故宫开放时间','帮我查故宫开放时间','图书馆营业时间','今天日出时间','营业现在几点','故宫明天开放吗帮我查一下','时间','几点','明天','多久','今天是几','你告诉我今天是什么节日','什么时候开始','小可小可还有多少分钟能领到下一个金币','我离下一个宝箱还需要多久?','宝可梦比赛时间','吃饭时间'])test('external or incomplete '+q,()=>assert.equal(resolveClock(q),null));
test('event context cannot turn a city followup into clock',()=>assert.equal(resolveClock('那纽约呢',['你帮我查一查宝可梦的比赛']),null));
test('event opening answers remain in ordinary history',()=>{const h=[{role:'user',content:'故宫开放时间'},{role:'assistant',content:'请补充想去的日期。'}];assert.deepEqual(stripClockTurns(h),h);});
for(const q of ['你告诉我现在几点','麻烦你告诉我现在几点','麻烦你帮我查一下现在几点','可以帮我查一查现在几点'])test('polite composed '+q,()=>assert.equal(resolveClock(q)?.kind,'clock'));
for(const q of ['比赛现在几点','现在比赛几点','活动今天几号','节日时间','麻烦你告诉我今天几号'])test('review event/polite '+q,()=>assert.equal(resolveClock(q)?.kind??null,q.startsWith('麻烦')?'clock':null));
// Dispatcher 433 supplemental diagnosis; not historical user corpus.
for(const q of ['能说一下现在几点了吗','能不能说一下现在几点了吗'])test('dispatcher polite diagnostic '+q,()=>assert.equal(resolveClock(q)?.kind,'clock'));
test('polite weekday with no prior referent means today',()=>assert.deepEqual(resolveClock('请问星期几'),{kind:'clock',iana:'Asia/Shanghai',place_label:'北京时间',requested:'weekday'}));
test('polite weekday preserves event referent',()=>assert.equal(resolveClock('请问星期几',['你帮我查一查宝可梦的比赛']),null));
test('polite weekday may follow explicit clock',()=>assert.equal(resolveClock('请问星期几',['今天几号'])?.kind,'clock'));
