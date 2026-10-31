import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildKnowledgeRecall,isArkStateQuestion} from '../src/xiaoke-kb.js';
test('当前G1奖励问句优先召回有效专注与领取边界，不借旧夜航解释',()=>{
 for(const q of ['还有多少分钟能领到下一个金币','如何领取下次奖励','我睡醒之后还有多久能领下一次奖励']){
  const v=buildKnowledgeRecall(q);assert.ok(v);assert.match(v,/有效专注/);assert.match(v,/下一.*宝箱/);assert.doesNotMatch(v,/方舟每晚自动出动|离开越久越沉甸甸/);
 }
});
test('静态资源用途保留独立双钱包和现实奖励约定边界',()=>{const v=buildKnowledgeRecall('金币是做什么的');assert.match(v!,/家族币/);assert.match(v!,/星尘/);assert.match(v!,/约定/);});
test('外部游戏及普通闲聊不会被G1状态召回污染',()=>{assert.equal(buildKnowledgeRecall('原神金币还有多少'),null);assert.equal(buildKnowledgeRecall('给我讲个笑话'),null);});

test('ordinary classroom rewards are not game state or knowledge requests',()=>{for(const text of ['老师今天奖励了我一朵小红花','我今天奖励自己一支画笔','我给你讲一个奖励小朋友的故事','爸爸说下次奖励我去游乐园','我讲个诺亚方舟的故事，今天动物们出发了']){assert.equal(isArkStateQuestion(text),false);if(!text.includes('方舟'))assert.equal(buildKnowledgeRecall(text),null);}});
