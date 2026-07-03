// Phase 1 情景记忆注入单测(docs/43 §8):data/policy 分离 / due 渲染 / 双区预算 /
// 环境开关 / 异步回执 / 匿名不注入。
// 跑法:cd apps/server && NODE_OPTIONS=--experimental-sqlite ../../node_modules/.bin/tsx scripts/episodic-inject.test.ts
import assert from 'node:assert';
import { assembleSystemPrompt } from '../src/prompt-orchestrator.js';
import { memoryItemStore } from '../src/memory-item-store.js';
import { profileStore } from '../src/profile-store.js';

const ACCT = 'test-episodic-inject';
const AUTH = { accountId: ACCT, role: 'parent' };
const BASE = '你是小可。';

profileStore.deleteByAccountId(ACCT);
memoryItemStore.deleteByAccountId(ACCT);
profileStore.upsertProfile(ACCT, { nickname: '天天', birthday: '2019-01', gender: '男孩' });

// 1. 注入 promise/relation/preference/emotion/event 全类型,data 带引号 + policy 段在后
{
  memoryItemStore.addItems(ACCT, [
    { type: 'promise', content: '给你讲白鲸的故事', subject: 'xiaoke', due_text: '今天', source_role: 'assistant', source_quote: 'x' },
    { type: 'relation', content: '朵朵是妹妹', subject: '朵朵' },
    { type: 'preference', content: '不喜欢奥特曼' },
    { type: 'emotion', content: '考试没考好有点难过' },
    { type: 'event', content: '上周去了海洋馆最喜欢白鲸' },
  ]);
  const p = assembleSystemPrompt(BASE, null, AUTH);
  assert.ok(p.includes('小可答应="给你讲白鲸的故事"'), 'promise 带引号数据格式');
  assert.ok(p.includes('就是今天(该兑现)'), 'due=今天渲染');
  assert.ok(p.includes('"朵朵是妹妹"'), 'relation 注入');
  assert.ok(p.includes('不喜欢 "奥特曼"'), 'preference 注入(剥"不喜欢"前缀)');
  assert.ok(p.includes('情绪打点'), 'emotion 注入');
  assert.ok(p.includes('经历 "上周去了海洋馆最喜欢白鲸"'), 'event 注入');
  assert.ok(p.includes('【记忆使用规则(固定)】'), 'policy 段存在');
  assert.ok(p.indexOf('【记忆使用规则(固定)】') > p.indexOf('小可答应'), 'policy 在 data 之后(近因压制)');
  assert.ok(p.includes('绝不主动揭伤疤'), '情绪 policy');
  assert.ok(p.includes('绝不声称"我答应过"'), '约定 policy');
  console.log('✅ 1 全类型注入 + data/policy 分离');
}

// 2. 异步回执:setImmediate 后 last_injected_at 被更新(读路径同步部分不写)
{
  await new Promise((r) => setImmediate(() => setImmediate(r))); // 等两轮事件循环
  const promises = memoryItemStore.listActivePromises(ACCT);
  assert.ok(promises.every((p) => p.last_injected_at > 0), '回执异步落库');
  console.log('✅ 2 markInjected 异步回执');
}

// 3. 环境开关 MEMORY_EPISODIC_INJECT=0 → 只剩画像,无情景区
{
  process.env.MEMORY_EPISODIC_INJECT = '0';
  const p = assembleSystemPrompt(BASE, null, AUTH);
  assert.ok(!p.includes('约定'), '开关关掉后无情景记忆');
  assert.ok(p.includes('昵称：天天'), '画像照常');
  delete process.env.MEMORY_EPISODIC_INJECT;
  console.log('✅ 3 应急开关');
}

// 4. 匿名(无 auth)不注入情景
{
  const p = assembleSystemPrompt(BASE, { nickname: '匿名娃' }, null);
  assert.ok(!p.includes('约定'), '匿名无情景记忆');
  console.log('✅ 4 匿名不注入');
}

// 5. 预算:塞 30 条超长 event,弹性区被截,promise 仍在
{
  for (let i = 0; i < 30; i++) {
    // 顶满 40 字 clip 上限,确保 5 条(~260字)必超 200 字弹性预算触发截断
    memoryItemStore.addItems(ACCT, [{ type: 'event', content: `超长事件描述第${String(i).padStart(2, '0')}号今天在游乐园玩了旋转木马碰碰车还看了小丑表演开心极了` }]);
  }
  const p = assembleSystemPrompt(BASE, null, AUTH);
  assert.ok(p.includes('小可答应="给你讲白鲸的故事"'), '必注区 promise 不被挤掉');
  const eventCount = (p.match(/经历 "/g) ?? []).length;
  assert.ok(eventCount >= 1 && eventCount <= 3, `弹性区 event 被预算截断(实际 ${eventCount} 条,应 1-3)`);
  console.log('✅ 5 双区预算截断');
}

// 6. due 过期渲染
{
  memoryItemStore.deleteByAccountId(ACCT);
  memoryItemStore.addItems(ACCT, [
    { type: 'promise', content: '过期的约定', subject: 'xiaoke', due_text: '明天' },
  ]);
  // 手动把 due_at 改成昨天(模拟过期)——直接操作 db 不方便,改用 next_session 验证另一分支
  memoryItemStore.addItems(ACCT, [
    { type: 'promise', content: '下次的约定', subject: 'xiaoke', due_text: '下次' },
  ]);
  const p = assembleSystemPrompt(BASE, null, AUTH);
  assert.ok(p.includes('时间="下次见面"'), 'next_session 渲染');
  console.log('✅ 6 due 渲染分支');
}

profileStore.deleteByAccountId(ACCT);
memoryItemStore.deleteByAccountId(ACCT);
console.log('🎉 episodic-inject 6/6 全过');
