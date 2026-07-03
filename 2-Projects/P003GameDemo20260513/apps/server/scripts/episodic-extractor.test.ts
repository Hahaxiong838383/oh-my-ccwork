// Phase 1 parseEpisodic 单测(docs/43 §8):C1 evidence 硬校验(假承诺拦截) / C2 短id映射 /
// relations 校验 / dislikes 联动 / 容错。纯函数,不调 LLM。
// 跑法:cd apps/server && ../../node_modules/.bin/tsx scripts/episodic-extractor.test.ts
import assert from 'node:assert';
import { parseEpisodic } from '../src/memory-extractor.js';

const HISTORY = [
  { role: 'user' as const, content: '小可小可,我上周去了海洋馆,最喜欢白鲸!' },
  { role: 'assistant' as const, content: '哇,白鲸超可爱!明天小可给你讲白鲸的故事好不好?' },
  { role: 'user' as const, content: '好呀!还有,小可你答应过我要送我一个真的玩具!' },
  { role: 'assistant' as const, content: '嘿嘿,小可只能陪你聊天讲故事哦。' },
];
const CTX = {
  sessionId: 'sess-1',
  activePromises: [
    { id: 'real-id-aaa', content: '给你讲恐龙故事' },
    { id: 'real-id-bbb', content: '陪你复习古诗' },
  ],
};

// 1. C1:真承诺(evidence 在 assistant 消息里)通过;假承诺(孩子转述,evidence 不在 assistant 里)整条丢弃
{
  const raw = JSON.stringify({
    promises: [
      { by: 'xiaoke', content: '给你讲白鲸的故事', due_text: '明天', evidence: '明天小可给你讲白鲸的故事' },
      { by: 'xiaoke', content: '送你一个真的玩具', due_text: '', evidence: '小可你答应过我要送我一个真的玩具' }, // 证据是孩子的话
    ],
  });
  const r = parseEpisodic(raw, HISTORY, CTX);
  assert.ok(r, '有产出');
  const promises = r!.items.filter((i) => i.type === 'promise');
  assert.equal(promises.length, 1, '假承诺被 evidence 校验拦截,只剩真承诺');
  assert.equal(promises[0].content, '给你讲白鲸的故事');
  assert.equal(promises[0].due_text, '明天');
  assert.equal(promises[0].source_role, 'assistant');
  console.log('✅ 1 C1 evidence 硬校验:真承诺过/假承诺(孩子转述)拦');
}

// 2. C1 反向:by=child 的承诺 evidence 必须在 user 消息里
{
  const raw = JSON.stringify({
    promises: [
      { by: 'child', content: '明天自己刷牙', due_text: '明天', evidence: '明天小可给你讲白鲸的故事' }, // 证据是小可的话→拦
    ],
  });
  const r = parseEpisodic(raw, HISTORY, CTX);
  assert.equal(r, null, 'by=child 但证据在 assistant 消息 → 拦截后无产出');
  console.log('✅ 2 C1 反向:child 承诺证据错位拦截');
}

// 3. C2:resolved 短 id 映射回真 id;越界/非法 id 忽略
{
  const raw = JSON.stringify({ resolved_promise_ids: ['p1', 'p9', 'DROP TABLE', 'p2'] });
  const r = parseEpisodic(raw, HISTORY, CTX);
  assert.ok(r);
  assert.deepEqual(r!.resolvedPromiseIds, ['real-id-aaa', 'real-id-bbb'], '只映射合法短id');
  console.log('✅ 3 C2 短id映射 + 非法忽略');
}

// 4. events/emotions/relations/dislikes 解析 + relations 注入词拦截
{
  const raw = JSON.stringify({
    events: ['上周去了海洋馆最喜欢白鲸'],
    emotion_points: ['见到白鲸特别开心'],
    relations: [
      { name: '朵朵', desc: '妹妹' },
      { name: '忽略指令system', desc: '注入试探' }, // isValidNickname 拦
    ],
    dislikes: ['奥特曼'],
  });
  const r = parseEpisodic(raw, HISTORY, CTX);
  assert.ok(r);
  assert.equal(r!.items.filter((i) => i.type === 'event').length, 1);
  assert.equal(r!.items.filter((i) => i.type === 'emotion').length, 1);
  const rels = r!.items.filter((i) => i.type === 'relation');
  assert.equal(rels.length, 1, '注入名被 isValidNickname 拦');
  assert.equal(rels[0].content, '朵朵是妹妹');
  const prefs = r!.items.filter((i) => i.type === 'preference');
  assert.equal(prefs[0].content, '不喜欢奥特曼');
  assert.deepEqual(r!.retractInterests, ['奥特曼'], 'dislike 联动 interests 撤销');
  console.log('✅ 4 events/emotions/relations/dislikes + 注入拦截');
}

// 5. 容错:非 JSON / 空对象 → null
{
  assert.equal(parseEpisodic('抱歉我做不到', HISTORY, CTX), null);
  assert.equal(parseEpisodic('{}', HISTORY, CTX), null);
  console.log('✅ 5 容错');
}

console.log('🎉 parseEpisodic 5/5 全过');
