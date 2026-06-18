// P1.2 memory-extractor.parsePatch 单测：LLM 输出 JSON → MemoryPatch 的矛盾检测/合并/容错。
// 跑法：cd apps/server && ./node_modules/.bin/tsx scripts/memory-extractor.test.ts
import assert from 'node:assert';
import { parsePatch } from '../src/memory-extractor.js';
import type { FamilyMember } from '../src/profile-store.js';

const cur: FamilyMember = {
  id: 'x', account_id: 'a', nickname: '小明', birthday: '2018-08', gender: '男孩',
  interests: [{ value: '恐龙', confidence: 0.9, last_updated: 1, source: 'voice' }],
  preferred_address: '', personality_notes: '', recent_emotion: '', created_at: 0, updated_at: 0,
};

// 1. 改名：新名 ≠ 旧名 → patch.nickname（语音改名核心）
{
  const p = parsePatch('{"nickname":"小白"}', cur);
  assert.ok(p && p.nickname === '小白', '改名生效');
  console.log('✅ 1 改名：新名≠旧名 → 更新');
}
// 2. 同名不更新（矛盾检测：没变化不写）
{
  const p = parsePatch('{"nickname":"小明"}', cur);
  assert.equal(p, null, '同名+无其他更新 → null');
  console.log('✅ 2 同名不更新');
}
// 3. 兴趣合并去重：新兴趣加入
{
  const p = parsePatch('{"interests":["奥特曼"]}', cur);
  assert.ok(p && p.interests && p.interests.length === 2, '恐龙+奥特曼=2');
  assert.ok(p.interests.some((i) => i.value === '奥特曼' && i.source === 'voice'), '新兴趣带 source');
  console.log('✅ 3 兴趣合并去重：新兴趣加入');
}
// 4. 已有兴趣不重复 → 无更新
{
  const p = parsePatch('{"interests":["恐龙"]}', cur);
  assert.equal(p, null, '已有兴趣不重复 → null');
  console.log('✅ 4 已有兴趣不重复');
}
// 5. 空 {} → null
{
  assert.equal(parsePatch('{}', cur), null, '空对象 → null');
  console.log('✅ 5 无更新 → null');
}
// 6. markdown 代码块包裹容错
{
  const p = parsePatch('```json\n{"nickname":"豆豆"}\n```', cur);
  assert.ok(p && p.nickname === '豆豆', '剥离 ```json 后正确 parse');
  console.log('✅ 6 markdown 代码块容错');
}
// 7. 改名 + 情绪锚点
{
  const p = parsePatch('{"nickname":"小白","recent_emotion":"考试没考好难过"}', cur);
  assert.ok(p && p.nickname === '小白' && p.recent_emotion === '考试没考好难过', '多字段');
  console.log('✅ 7 改名 + 情绪锚点同时抽取');
}
// 8. 坏 JSON → null（不崩）
{
  assert.equal(parsePatch('not json', cur), null, '坏 JSON → null');
  console.log('✅ 8 坏 JSON 容错 → null');
}

console.log('\n🎉 P1.2 memory-extractor.parsePatch 全过');
