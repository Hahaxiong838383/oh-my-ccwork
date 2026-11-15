import {test} from 'node:test';
import assert from 'node:assert/strict';
import {answerArk} from '../src/ark/answer.js';
import {buildKnowledgeRecall,isOutsideArkQuestion} from '../src/xiaoke-kb.js';
import type {ArkFacts} from '../src/ark/contracts.js';
const now=Date.parse('2026-11-15T10:00:00+08:00');
const value=(value:number)=>({value,occurred_at_ms:now,received_at_ms:now,content_version:'synthetic'});
const facts:ArkFacts={schema_version:1,assets:{family_coin:value(0),stardust:value(77),makeup_card:null},progress:null};
const user=(content:string)=>({role:'user',content});
test('gold icon means family coin: explain known use without asking which currency',()=>{
 for(const q of ['金币','金币有什么用','1900金币','1900金币能干','1900金币能干什么','金币是干嘛的','金币有啥用','方舟显示的金币是什么']){
  const a=answerArk(q,undefined,[],now);assert.match(a??'',/金币.*家族币/,q);assert.match(a!,/家长|爸妈/,q);
  assert.doesNotMatch(a!,/还是星尘|哪一种|查不到|不知道/,q);
  const kb=buildKnowledgeRecall(q);assert.match(kb??'',/金币.*就是家族币/);assert.doesNotMatch(kb!,/先简短说明两类用途|你说的是哪一种|可能指旧版/);
 }
});
test('gold balance reads only family_coin; missing value never borrows stardust or becomes zero',()=>{
 for(const q of ['我有几枚金币','金币还有多少','我还有金币吗']){
  const a=answerArk(q,facts,[],now)!;assert.match(a,/家族币余额是0枚/);assert.doesNotMatch(a,/77|还是星尘/);
  const missing=answerArk(q,{...facts,assets:{...facts.assets,family_coin:null}},[],now)!;
  assert.match(missing,/家族币.*查不到/);assert.doesNotMatch(missing,/77|是0枚/);
 }
 assert.match(answerArk('星尘有多少',facts,[],now)!,/77/);
 assert.doesNotMatch(answerArk('今天赚了多少金币',facts,[],now)!,/余额是0|赚了0|77/);
});
test('in-game item exchange uses stardust guidance without claiming a catalog or completed purchase',()=>{
 for(const q of ['游戏道具怎么兑换','怎么兑换游戏道具','方舟里的装饰怎么买','小可换装用什么','小可小可我这个金币怎么买企鹅摆件啊','你刚才说金币可以换企鹅摆件我现在要换我怎么操作']){
  assert.equal(isOutsideArkQuestion(q),false,q);
  const a=answerArk(q,undefined,[],now);assert.match(a??'',/星尘/,q);assert.match(a!,/页面/,q);
  assert.doesNotMatch(a!,/查不到|已经.*兑换|已.*买好|需要\d+|花\d+|还是星尘/,q);
  assert.match(buildKnowledgeRecall(q)??'',/星尘.*游戏道具/,q);
 }
});
test('exchange price and affordability do not use wallet balance as price or promise stock',()=>{
 for(const q of ['企鹅摆件要多少金币','多少金币能买企鹅摆件','我有400金币能买企鹅摆件吗','星尘够不够换这个道具']){
  const a=answerArk(q,facts,[],now)!;assert.match(a,/星尘/);assert.match(a,/页面/);
  assert.doesNotMatch(a,/77|余额是0|需要0|足够|已经兑换|肯定能买/);
 }
});
test('resource followups share knowledge and direct reply, and stop at a user topic change',()=>{
 const h=[user('金币有什么用'),{role:'assistant',content:'错误旧回答：金币可以买企鹅摆件'}];
 for(const q of ['那能换什么','那怎么买企鹅摆件','好你帮我换吧']){
  const a=answerArk(q,undefined,h,now);assert.match(a??'',/家族币/);assert.match(a!,/星尘/);assert.match(buildKnowledgeRecall(q,h)??'',/家族币/);
 }
 for(const h2 of [[],[{role:'assistant',content:'金币可以买东西'}],[user('金币有什么用'),user('今天天气怎么样')],[user('原神金币有什么用')]]){
  assert.equal(answerArk('那能换什么',undefined,h2,now),null);assert.equal(buildKnowledgeRecall('那能换什么',h2),null);
 }
 for(const q of ['那怎么买电脑','那怎么买衣服','我想兑换人民币','那帮我买肯德基']){
  assert.equal(answerArk(q,undefined,h,now),null,q);assert.ok(!buildKnowledgeRecall(q,h)?.includes('【方舟资源'),q);
 }
});
test('outside games, real commerce, quotation and ordinary conversation are not Ark exchange intents',()=>{
 for(const q of ['原神的金币有什么用','我的世界游戏道具怎么兑换','其他游戏的道具怎么买','天上的星辰是什么','今天金价多少','我想买一件衣服','装饰圣诞树怎么买材料','翻译金币有什么用','他说金币可以买道具这句话什么意思']){
  assert.equal(answerArk(q,undefined,[],now),null,q);assert.ok(!buildKnowledgeRecall(q)?.includes('【方舟资源'),q);
 }
 for(const q of ['家族币能换爸妈约定的奖励吗','家族币能换爸爸妈妈约定的奖励吗']){
  const a=answerArk(q,undefined,[],now)??'';assert.match(a,/家长|爸妈/);assert.doesNotMatch(a,/星尘|查不到/);
 }
});
