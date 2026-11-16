import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {resolveClock,answerClock} from '../src/tools/clock-query.js';
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
