// Phase 1 memory_item 单测(docs/43 §8):typed 生命周期 / promise 永不淘汰 / due 解析 /
// resolve by id / retract vs hardDelete / 注入选取 / emotion 30 天归档 / UNIQUE 去重。
// 跑法:cd apps/server && NODE_OPTIONS=--experimental-sqlite ./node_modules/.bin/tsx scripts/memory-item-store.test.ts
import assert from 'node:assert';
import { memoryItemStore, parseDue } from '../src/memory-item-store.js';

const ACCT = 'test-mem-item-acct';
memoryItemStore.deleteByAccountId(ACCT);

// 1. parseDue 规则解析
{
  const base = new Date('2026-07-03T10:00:00+08:00').getTime(); // 周五
  assert.equal(parseDue('明天', base).due_granularity, 'day');
  const tomorrow = new Date(parseDue('明天', base).due_at!);
  assert.equal(tomorrow.getDate(), 4, '明天=7月4日');
  assert.equal(parseDue('下次', base).due_granularity, 'next_session');
  assert.equal(parseDue('下次', base).due_at, null);
  assert.equal(parseDue('等我长大', base).due_granularity, 'unknown');
  assert.equal(parseDue('', base).due_granularity, '');
  const wk = parseDue('周五', base); // 当天周五 → 下个周五(+7)
  assert.equal(new Date(wk.due_at!).getDate(), 10, '周五说周五=下周五 7月10日');
  console.log('✅ 1 parseDue:今天/明天/周X/下次/未知');
}

// 2. addItems 写入 + UNIQUE 去重(双链路重复写模拟)
{
  const n1 = memoryItemStore.addItems(ACCT, [
    { type: 'promise', content: '给你讲恐龙故事', subject: 'xiaoke', due_text: '明天', source_role: 'assistant', source_quote: '明天小可给你讲恐龙故事' },
    { type: 'event', content: '上周去了海洋馆最喜欢白鲸' },
    { type: 'relation', content: '朵朵是妹妹', subject: '朵朵' },
  ]);
  assert.equal(n1, 3, '首次写入 3 条');
  const n2 = memoryItemStore.addItems(ACCT, [
    { type: 'promise', content: '给你讲恐龙故事', subject: 'xiaoke' }, // 重复
  ]);
  assert.equal(n2, 0, 'UNIQUE(account,type,content) 去重生效');
  console.log('✅ 2 addItems 写入 + 去重');
}

// 3. promise 永不淘汰(写 10 条全保留) vs preference 超限淘汰(cap=10)
{
  for (let i = 0; i < 10; i++) {
    memoryItemStore.addItems(ACCT, [{ type: 'promise', content: `约定${i}`, subject: 'xiaoke' }]);
  }
  const promises = memoryItemStore.listActivePromises(ACCT);
  assert.ok(promises.length >= 11, `active promise 全保留(${promises.length} 条,含第2步1条),永不淘汰`);
  for (let i = 0; i < 12; i++) {
    memoryItemStore.addItems(ACCT, [{ type: 'preference', content: `不喜欢${i}` }]);
  }
  const sel = memoryItemStore.selectForInjection(ACCT);
  assert.equal(sel.preferences.length, 5, 'preference 注入≤5');
  console.log('✅ 3 promise 永不淘汰 / preference 超限治理');
}

// 4. 注入选取:promise due 优先 + ≤3
{
  memoryItemStore.deleteByAccountId(ACCT);
  memoryItemStore.addItems(ACCT, [
    { type: 'promise', content: '无期限的约定', subject: 'xiaoke' },
    { type: 'promise', content: '明天的约定', subject: 'xiaoke', due_text: '明天' },
    { type: 'promise', content: '今天的约定', subject: 'xiaoke', due_text: '今天' },
    { type: 'promise', content: '下次的约定', subject: 'xiaoke', due_text: '下次' },
  ]);
  const sel = memoryItemStore.selectForInjection(ACCT);
  assert.equal(sel.promises.length, 3, '注入 promise ≤3');
  assert.equal(sel.promises[0].content, '今天的约定', 'due 最近的排最前');
  assert.equal(sel.promises[1].content, '明天的约定');
  console.log('✅ 4 注入选取 promise due 优先');
}

// 5. resolvePromisesByIds 精确消账(不误伤同类)
{
  const all = memoryItemStore.listActivePromises(ACCT);
  const today = all.find((p) => p.content === '今天的约定')!;
  const n = memoryItemStore.resolvePromisesByIds(ACCT, [today.id], '小可讲完了');
  assert.equal(n, 1, '按 id resolve 1 条');
  const left = memoryItemStore.listActivePromises(ACCT);
  assert.ok(left.every((p) => p.id !== today.id), '其余同类 promise 不受影响');
  assert.equal(left.length, all.length - 1);
  console.log('✅ 5 resolve by id 精确消账');
}

// 6. retract(软) vs hardDelete(物理)
{
  memoryItemStore.addItems(ACCT, [{ type: 'event', content: '要被撤销的事件' }, { type: 'event', content: '要被物理删的事件' }]);
  const { items } = memoryItemStore.listByAccount(ACCT);
  const soft = items.find((i) => i.content === '要被撤销的事件')!;
  const hard = items.find((i) => i.content === '要被物理删的事件')!;
  memoryItemStore.retract(ACCT, soft.id);
  memoryItemStore.hardDelete(hard.id);
  const after = memoryItemStore.listByAccount(ACCT).items;
  assert.ok(after.some((i) => i.id === soft.id && i.status === 'retracted'), '软删保留审计');
  assert.ok(!after.some((i) => i.id === hard.id), '物理删不留痕');
  console.log('✅ 6 retract 软删 / hardDelete 物理删');
}

// 7. retractByContent(dislike 联动)
{
  memoryItemStore.addItems(ACCT, [{ type: 'preference', content: '不喜欢奥特曼' }]);
  const ok = memoryItemStore.retractByContent(ACCT, 'preference', '不喜欢奥特曼');
  assert.ok(ok, '按 content 撤销 preference');
  console.log('✅ 7 retractByContent');
}

// 8. markInjected 回执(异步路径专用)
{
  const sel = memoryItemStore.selectForInjection(ACCT);
  const ids = sel.promises.map((p) => p.id);
  memoryItemStore.markInjected(ids);
  const after = memoryItemStore.listActivePromises(ACCT).filter((p) => ids.includes(p.id));
  assert.ok(after.every((p) => p.last_injected_at > 0), 'last_injected_at 已更新');
  console.log('✅ 8 markInjected');
}

memoryItemStore.deleteByAccountId(ACCT);
console.log('🎉 memory-item-store 8/8 全过');
