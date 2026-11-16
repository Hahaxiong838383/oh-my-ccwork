import assert from 'node:assert/strict';
import { buildKnowledgeRecall } from '../src/xiaoke-kb.js';
for (const q of ['金币有什么用', '星辰有什么用', '道具有什么用', '补勤卡怎么用', '补签卡是干嘛的']) {
  const recall = buildKnowledgeRecall(q);
  assert.ok(recall, q);
  assert.match(recall, /星尘|补勤/, q);
}
for (const q of ['天上的星辰是什么', '黄金金币今天多少钱', '哆啦A梦的道具有哪些', '金鱼怎么养', '小可，天上的星辰是什么', '小可，哆啦A梦的道具有哪些', '小可，原神的金币有什么用', '星空中的星辰是什么', '我的世界金币怎么获得', '装饰圣诞树可以用什么']) {
  const recall = buildKnowledgeRecall(q);
  assert.ok(!recall?.includes('【方舟资源'), q);
}
assert.match(buildKnowledgeRecall('金币有什么用')!, /家族币/);
assert.match(buildKnowledgeRecall('星尘有什么用')!, /换装/);
assert.match(buildKnowledgeRecall('我有多少星尘')!, /余额.*本轮可信方舟事实/);
assert.match(buildKnowledgeRecall('补勤卡怎么用')!, /历史|补签/);
console.log('ark-resource regression passed');

assert.match(buildKnowledgeRecall('星尘能兑换人民币吗')!, /不能兑换现实金钱/);
