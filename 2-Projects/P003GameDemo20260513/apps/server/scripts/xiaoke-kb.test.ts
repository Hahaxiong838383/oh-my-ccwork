// xiaoke-kb 按需召回单测：孩子话题命中→召回对应条目+红线、闲聊→不召回、未上线功能→边界、多命中→限制≤3。
// 跑法：cd apps/server && NODE_OPTIONS=--experimental-sqlite ./node_modules/.bin/tsx scripts/xiaoke-kb.test.ts
import assert from 'node:assert';
import { buildKnowledgeRecall, matchesKnowledge } from '../src/xiaoke-kb.js';

// case1: 闲聊不命中 → null（不注入、不稀释人格）
{
  assert.equal(buildKnowledgeRecall('今天天气真好我们出去玩吧'), null, '闲聊不召回');
  assert.equal(matchesKnowledge('今天天气真好'), false, '闲聊不命中');
  console.log('✅ case1 闲聊：不召回(null)');
}

// case2: 聊经济 → 召回经济条目 + 红线 + "隐性运用"指令头
{
  const r = buildKnowledgeRecall('小可我攒了好多星尘可以换装吗');
  assert.ok(r, '命中经济召回');
  assert.ok(r!.includes('家族币') && r!.includes('星尘'), '经济条目内容');
  assert.ok(r!.includes('真实性') && r!.includes('绝不编造'), '附真实性红线');
  assert.ok(r!.includes('本轮隐性运用'), '带"隐性运用"指令头(别照读/别当说明书)');
  console.log('✅ case2 经济：召回经济条目 + 红线');
}

// case3: 问身世 → 召回创世故事条目
{
  const r = buildKnowledgeRecall('小可你为什么没有脸呀你从哪来的');
  assert.ok(r && r.includes('守灯人') && r.includes('微光'), '身世条目(守灯人/微光)');
  console.log('✅ case3 身世：召回创世故事');
}

// case4: 聊藏品 → 召回藏品条目（强调讲品类）
{
  const r = buildKnowledgeRecall('我夜航带回来一只机械恐龙');
  assert.ok(r && r.includes('机械恐龙') && r.includes('讲到具体品类'), '藏品条目讲品类');
  console.log('✅ case4 藏品：召回品类素材');
}

// case5: 问还没上线的（光灵/坐骑）→ 召回边界条目（只当"将来会有"）
{
  const r = buildKnowledgeRecall('小可你有光灵吗能骑坐骑吗');
  assert.ok(r && r.includes('将来会有') && r.includes('绝不能讲成现有'), '后续功能边界');
  console.log('✅ case5 未上线：光灵/坐骑作"将来会有"边界');
}

// case6: 多话题一句命中 → 召回但限制 ≤3 条（防 prompt 爆长）
{
  const r = buildKnowledgeRecall('我开宝箱拿到机械恐龙还升级了生态缸看看夜航');
  assert.ok(r && r.includes('家族币') && r.includes('机械恐龙') && r.includes('星光草'), '前3条(经济/藏品/生态缸)召回');
  assert.ok(!r!.includes('物资堆'), '第4条(夜航)被截断，限制≤3生效');
  console.log('✅ case6 多命中：限制 ≤3 条防爆长');
}

console.log('\n🎉 xiaoke-kb 按需召回 全部通过');
