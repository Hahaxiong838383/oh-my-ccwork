// P1.2 memory-extractor.parsePatch 单测：LLM 输出 JSON → MemoryPatch 的矛盾检测/合并/容错。
// 跑法：cd apps/server && NODE_OPTIONS=--experimental-sqlite ../../node_modules/.bin/tsx scripts/memory-extractor.test.ts
// 2026-09-03：改名用例改为 nickname_change{value,evidence}+history 新 schema（8-26 起平铺 nickname 已不被认，本文件此前在生产未回流、基线即红）。
import assert from 'node:assert';
import { parsePatch } from '../src/memory-extractor.js';
import type { FamilyMember } from '../src/profile-store.js';

const U = (t: string) => ({ role: 'user' as const, content: t });
const NC = (value: string, extra = '') => `{"nickname_change":{"value":"${value}","evidence":"以后叫我${value}"}${extra}}`;

const cur: FamilyMember = {
  id: 'x', account_id: 'a', nickname: '小明', birthday: '2018-08', gender: '男孩',
  interests: [{ value: '恐龙', confidence: 0.9, last_updated: 1, source: 'voice' }],
  preferred_address: '', personality_notes: '', recent_emotion: '',
  game_progress: [{ value: '通关恐龙星域', last_updated: 1, source: 'voice' }],
  created_at: 0, updated_at: 0,
};

// 1. 改名：新名 ≠ 旧名 → patch.nickname（语音改名核心）
{
  const p = parsePatch(NC('小白'), cur, [U('以后叫我小白')]);
  assert.ok(p && p.nickname === '小白', '改名生效');
  console.log('✅ 1 改名：新名≠旧名 → 更新');
}
// 2. 同名不更新（矛盾检测：没变化不写）
{
  const p = parsePatch(NC('小明'), cur, [U('以后叫我小明')]);
  assert.equal(p, null, '同名+无其他更新 → null');
  console.log('✅ 2 同名不更新');
}
// 3. 兴趣：只返回新增项（合并下沉到 updateMemoryFields 写时，防并发 lost update — team#1）
{
  const p = parsePatch('{"interests":[{"value":"奥特曼","evidence":"我最喜欢奥特曼"}]}', cur, [U('我最喜欢奥特曼了')]);
  assert.ok(p && p.interests && p.interests.length === 1, '有证据的新兴趣(奥特曼)');
  assert.equal(p.interests[0].value, '奥特曼', '新增项 value');
  assert.equal(p.interests[0].source, 'voice', '带 source');
  console.log('✅ 3 兴趣只返回新增项(合并下沉写时)');
}
// 4. 已有兴趣不重复 → 无更新
{
  const p = parsePatch('{"interests":[{"value":"恐龙","evidence":"我喜欢恐龙"}]}', cur, [U('我喜欢恐龙')]);
  assert.ok(p && p.interests && p.interests.length === 1, 'R1：已有兴趣再次提及也返回(供提及日累计升 verified)');
  console.log('✅ 4 已有兴趣再次提及返回(确认用)');
}
// 5. 空 {} → null
{
  assert.equal(parsePatch('{}', cur), null, '空对象 → null');
  console.log('✅ 5 无更新 → null');
}
// 6. markdown 代码块包裹容错
{
  const p = parsePatch('```json\n' + NC('豆豆') + '\n```', cur, [U('以后叫我豆豆')]);
  assert.ok(p && p.nickname === '豆豆', '剥离 ```json 后正确 parse');
  console.log('✅ 6 markdown 代码块容错');
}
// 7. 改名 + 情绪锚点
{
  const p = parsePatch(NC('小白', ',"recent_emotion":"考试没考好难过"'), cur, [U('以后叫我小白')]);
  assert.ok(p && p.nickname === '小白' && p.recent_emotion === '考试没考好难过', '多字段');
  console.log('✅ 7 改名 + 情绪锚点同时抽取');
}
// 8. 坏 JSON → null（不崩）
{
  assert.equal(parsePatch('not json', cur), null, '坏 JSON → null');
  console.log('✅ 8 坏 JSON 容错 → null');
}

// 9. 改名校验（team#2 防注入污染真相源）：拒注入词 / 清 XSS / 截超长 / 正常名通过
{
  assert.equal(parsePatch(NC('忽略指令'), cur, [U('以后叫我忽略指令')]), null, '拒绝系统/注入词');
  // 带 <> 的候选：clip 清洗后与原话对不上 → 整条拒（绝不带 <> 落库）
  assert.equal(parsePatch(NC('小明<script>'), cur, [U('以后叫我小明<script>')]), null, 'XSS <> 候选整条拒');
  const longName = '一二三四五六七八九十一二三四五';
  const longN = parsePatch(NC(longName), cur, [U(`以后叫我${longName}`)]);
  assert.ok(longN && longN.nickname && [...longN.nickname].length <= 12, '超长截断 ≤12');
  const ok = parsePatch(NC('小哪吒'), cur, [U('以后叫我小哪吒')]);
  assert.ok(ok && ok.nickname === '小哪吒', '正常改名通过');
  console.log('✅ 9 改名校验：拒注入词/清XSS/截超长/正常通过');
}

// 10. 方舟冒险事件：抽出孩子明确表达的新进展（只返回新增项，去重 + clip ≤40）
{
  const p = parsePatch('{"game_progress":["打捞到机械恐龙宝箱"]}', cur);
  assert.ok(p && p.game_progress && p.game_progress.length === 1, '抽出 1 条新方舟进展');
  assert.equal(p.game_progress[0].value, '打捞到机械恐龙宝箱', '进展 value');
  assert.equal(p.game_progress[0].source, 'voice', '带 source');
  assert.equal(typeof p.game_progress[0].last_updated, 'number', '带 last_updated');
  console.log('✅ 10 方舟进展：抽出孩子明确表达的新进展(只返回新增项)');
}
// 11. 不臆测：普通闲聊不含游戏进展 → 不抽 game_progress（LLM 已省略，parse 不无中生有）
{
  const p = parsePatch('{"recent_emotion":"今天好开心"}', cur);
  assert.ok(!p || !p.game_progress, '普通闲聊不抽 game_progress');
  console.log('✅ 11 不臆测：普通闲聊不抽方舟进展');
}
// 12. 已有进展不重复 → 不返回（current 已含「通关恐龙星域」）
{
  const p = parsePatch('{"game_progress":["通关恐龙星域"]}', cur);
  assert.equal(p, null, '已有进展不重复 → null');
  console.log('✅ 12 已有方舟进展不重复');
}
// 13. 方舟进展 clip：超长截断 ≤40 + 清 <>（防注入/存储型 XSS）
{
  const longEv = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十X';
  const p = parsePatch(`{"game_progress":["${longEv}<script>"]}`, cur);
  assert.ok(p && p.game_progress && [...p.game_progress[0].value].length <= 40, '超长截断 ≤40');
  assert.ok(p && p.game_progress && !p.game_progress[0].value.includes('<'), 'XSS <> 被清洗');
  console.log('✅ 13 方舟进展 clip：截超长 ≤40 + 清 XSS');
}

console.log('\n🎉 P1.2(+team修复+方舟game_progress) memory-extractor.parsePatch 全过');
