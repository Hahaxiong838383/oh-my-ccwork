/**
 * L2 记忆带出时机 + R2 证据链 单测（临时库）· 跑法：
 *   cd apps/server && NODE_OPTIONS=--experimental-sqlite ../../node_modules/.bin/tsx scripts/recall-provenance.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'recall-prov-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.CONVERSATION_DB_PATH = join(tmp, 'conversation.db');

const { memoryItemStore } = await import('../src/memory-item-store.js');
const { conversationStore } = await import('../src/conversation-store.js');
const { parseEpisodic, attachSourceIds, applyRelikes } = await import('../src/memory-extractor.js');
const { buildReunionLine, assembleSystemPrompt } = await import('../src/prompt-orchestrator.js');
const { profileStore } = await import('../src/profile-store.js');

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else { fail += 1; console.error(`FAIL ${name} got=${g} want=${w}`); }
}
const U = (t: string, id?: string) => ({ role: 'user' as const, content: t, id });
const A = (t: string, id?: string) => ({ role: 'assistant' as const, content: t, id });
const ACC = 'device-RPTEST0001';
const AUTH = { accountId: ACC, role: 'device' as const };

// ── R2 列与取代语义 ──
memoryItemStore.deleteByAccountId(ACC);
memoryItemStore.addItems(ACC, [
  { type: 'event', content: '上周去了海洋馆', source_msg_id: 'msg-1', session_id: 's' },
  { type: 'promise', content: '讲白鲸的故事', subject: 'xiaoke', source_role: 'assistant', source_quote: '明天给你讲白鲸', due_text: '明天', meta: { expect: '听白鲸故事' } },
]);
{
  const rows = memoryItemStore.listByAccount(ACC).items;
  const ev = rows.find((r) => r.type === 'event')!;
  const pr = rows.find((r) => r.type === 'promise')!;
  eq('p-1 source_msg_id 落库', ev.source_msg_id, 'msg-1');
  eq('p-2 valid_from 有值/valid_to 空', [typeof ev.valid_from, ev.valid_to], ['number', null]);
  eq('p-3 meta.expect 落库', JSON.parse(pr.meta).expect, '听白鲸故事');
  eq('p-4 retract 带取代指针', memoryItemStore.retract(ACC, ev.id, 'relike:msg-9'), true);
  const ev2 = memoryItemStore.listByAccount(ACC).items.find((r) => r.id === ev.id)!;
  eq('p-5 取代指针/valid_to/status', [ev2.superseded_by, typeof ev2.valid_to, ev2.status], ['relike:msg-9', 'number', 'retracted']);
  eq('p-6 复活清指针', memoryItemStore.reviveIfRetracted(ACC, 'event', '上周去了海洋馆', 's2'), true);
  const ev3 = memoryItemStore.listByAccount(ACC).items.find((r) => r.id === ev.id)!;
  eq('p-7 复活后 superseded_by 空/valid_to 空', [ev3.superseded_by, ev3.valid_to, ev3.status], ['', null, 'active']);
}
// 上限淘汰也写 valid_to + cap_evict
{
  const cs = Array.from({ length: 9 }, (_, i) => ({ type: 'concern' as const, content: `关心事${i}`, due_text: '' }));
  memoryItemStore.addItems(ACC, cs);
  const all = memoryItemStore.listByAccount(ACC).items.filter((r) => r.type === 'concern');
  const evicted = all.filter((r) => r.status === 'retracted');
  eq('p-8 超限淘汰 1 条', evicted.length, 1);
  eq('p-9 淘汰标 cap_evict + valid_to', [evicted[0]?.superseded_by, typeof evicted[0]?.valid_to], ['cap_evict', 'number']);
}

// ── conversation 反查 id ──
const c1 = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'user', text: '我昨天去了动物园' });
eq('c-1 按原话反查 id', conversationStore.findRecentIdByText(ACC, 'user', '我昨天去了动物园'), c1.id);
eq('c-2 找不到=null', conversationStore.findRecentIdByText(ACC, 'user', '没说过的话'), null);

// ── parseEpisodic expect ──
{
  const raw = JSON.stringify({ promises: [{ by: 'xiaoke', content: '讲白鲸', due_text: '明天', evidence: '明天给你讲白鲸', expect: '听白鲸故事' }] });
  const ep = parseEpisodic(raw, [U('好'), A('明天给你讲白鲸的故事')], { sessionId: 's', activePromises: [] });
  eq('e-1 promise.expect 进 meta', (ep?.items[0]?.meta as { expect?: string } | undefined)?.expect, '听白鲸故事');
  const ep2 = parseEpisodic(JSON.stringify({ promises: [{ by: 'xiaoke', content: '讲白鲸', due_text: '', evidence: '明天给你讲白鲸' }] }), [A('明天给你讲白鲸的故事')], { sessionId: 's', activePromises: [] });
  eq('e-2 无 expect 不带 meta', ep2?.items[0]?.meta, undefined);
}

// ── attachSourceIds ──
{
  const snap = [U('我昨天去了动物园'), A('哇', 'a-1'), U('我不喜欢老虎', 'u-2'), A('好', 'a-2')];
  const items = [
    { type: 'event' as const, content: '去了动物园', source_role: 'user', source_quote: '去了动物园' },
    { type: 'preference' as const, content: '不喜欢老虎', source_role: 'user' },
  ];
  attachSourceIds(ACC, items, snap);
  eq('s-1 有证据→含证据那条(无 id 走反查)', items[0].source_msg_id, c1.id);
  eq('s-2 无证据→本轮孩子消息 id', items[1].source_msg_id, 'u-2');
  // 无证据但内容明显来自前一轮孩子消息（LLM 改写短语）→ 按字符重合度定位到那一轮
  const snap2 = [U('我昨天和爸爸去了海洋馆最喜欢白鲸', 'u-a'), A('哇', 'a-a'), U('好明天你要讲白鲸的故事', 'u-b'), A('一定', 'a-b')];
  const items2 = [
    { type: 'event' as const, content: '昨天和爸爸去了海洋馆，最喜欢白鲸', source_role: 'user' },
    { type: 'emotion' as const, content: '开心', source_role: 'user' },
  ];
  attachSourceIds(ACC, items2, snap2);
  eq('s-4 无证据按重合度定位到前一轮', items2[0].source_msg_id, 'u-a');
  eq('s-5 太短/无重合→回退本轮', items2[1].source_msg_id, 'u-b');
}
// applyRelikes 写 relike:<msgId>
{
  profileStore.upsertBasics(ACC, { nickname: '测试', gender: '男孩' });
  memoryItemStore.addItems(ACC, [{ type: 'preference', content: '不喜欢恐龙', session_id: 's' }]);
  applyRelikes(ACC, [{ value: '恐龙', evidence: '我又喜欢恐龙了' }], profileStore.getProfile(ACC)!, 'u-7');
  const d = memoryItemStore.listByAccount(ACC).items.find((r) => r.content === '不喜欢恐龙')!;
  eq('s-3 撤回指针=relike:<msgId>', [d.status, d.superseded_by], ['retracted', 'relike:u-7']);
}

// ── L2 重逢回放 ──
const NOW = Date.now();
const ACC2 = 'device-RPTEST0002';
const seed = (rows: { role: 'user' | 'assistant'; text: string; ts: number }[]) => {
  for (const r of rows) {
    const it = conversationStore.add({ account_id: ACC2, session_id: 'rtc', role: r.role, text: r.text });
    // 回填时间戳（add 固定 Date.now()）
    (conversationStore as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare('UPDATE conversation SET ts = ? WHERE id = ?').run(r.ts, it.id);
  }
};
seed([
  { role: 'user', text: '我明天要去游泳课', ts: NOW - 3 * 3600_000 - 60_000 },
  { role: 'assistant', text: '好棒', ts: NOW - 3 * 3600_000 - 50_000 },
  { role: 'user', text: '嗯', ts: NOW - 3 * 3600_000 - 40_000 },
  { role: 'user', text: '我有点怕水', ts: NOW - 3 * 3600_000 - 30_000 },
  { role: 'assistant', text: '慢慢来', ts: NOW - 3 * 3600_000 - 20_000 },
]);
{
  const r = buildReunionLine(ACC2, NOW);
  eq('r-1 3 小时后重逢有回放', !!r, true);
  eq('r-2 取最后两句合格原话(应答词剔除,时间顺序)', r?.line.includes('"我明天要去游泳课" "我有点怕水"'), true);
  eq('r-3 gap 分钟', r?.gapMin, 180);
  const p = assembleSystemPrompt('BASE', null, AUTH as never, null, null, null, null, null, { skipInjectReceipt: true });
  eq('r-4 无历史账号不注入', p.includes('上次聊到'), false);
  const p2 = assembleSystemPrompt('BASE', null, { accountId: ACC2, role: 'device' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  eq('r-5 systemPrompt 含数据行与开场规则', [p2.includes('【上次聊到·数据】'), p2.includes('重逢开场可以自然提一句')], [true, true]);
  process.env.MEMORY_REUNION_RECALL = '0';
  const p3 = assembleSystemPrompt('BASE', null, { accountId: ACC2, role: 'device' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  eq('r-6 开关关=不注入', p3.includes('上次聊到'), false);
  delete process.env.MEMORY_REUNION_RECALL;
  // 刚聊过（1 分钟前）= 同一场，不注入
  seed([{ role: 'user', text: '我们继续聊游泳', ts: NOW - 60_000 }]);
  eq('r-7 同一场不注入', buildReunionLine(ACC2, NOW), null);
  // web 账号不注入
  const p4 = assembleSystemPrompt('BASE', null, { accountId: ACC2, role: 'parent' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  eq('r-8 非设备账号不注入', p4.includes('上次聊到'), false);
}

// ── 关心事到期措辞 + 约定到期核对 ──
{
  const ACC3 = 'device-RPTEST0003';
  memoryItemStore.addItems(ACC3, [
    { type: 'concern', content: '今天有数学考试有点紧张', due_text: '今天' },
    { type: 'promise', content: '讲白鲸的故事', subject: 'xiaoke', source_role: 'assistant', source_quote: 'x', due_text: '今天', meta: { expect: '听白鲸' } },
    { type: 'promise', content: '下周讲恐龙', subject: 'xiaoke', source_role: 'assistant', source_quote: 'y', due_text: '下周三', meta: { expect: '听恐龙' } },
  ]);
  const p = assembleSystemPrompt('BASE', null, { accountId: ACC3, role: 'device' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  eq('d-1 关心事今天措辞', p.includes('就是今天(可以关心一下)'), true);
  eq('d-2 约定今天带到期核对', p.includes('到期核对="听白鲸"'), true);
  eq('d-3 未到期不带核对', p.includes('到期核对="听恐龙"'), false);
  eq('d-4 到期核对规则句', p.includes('带「到期核对」的约定'), true);
}

// ── R1 注入分级：verified 进「兴趣」，unverified 进「还没确认」+ 规则句 ──
{
  const ACC4 = 'device-RPTEST0004';
  profileStore.upsertBasics(ACC4, { nickname: '小四', gender: '女' });
  profileStore.updateMemoryFields(ACC4, { interests: [
    { value: '恐龙', confidence: 0.8, last_updated: 1, source: 'voice', state: 'verified', mention_days: ['2026-09-01', '2026-09-02'] },
    { value: '画画', confidence: 0.5, last_updated: 2, source: 'voice', state: 'unverified', mention_days: ['2026-09-03'] },
    { value: '冷光', confidence: 0.5, last_updated: 3, source: 'voice', state: 'retracted', retracted_by: 'parent', mention_days: ['2026-09-03'] },
  ] });
  const p = assembleSystemPrompt('BASE', null, { accountId: ACC4, role: 'device' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  eq('t-1 verified 进兴趣行', p.includes('兴趣：恐龙'), true);
  eq('t-2 unverified 进还没确认行', p.includes('最近提到过(还没确认是不是真喜欢)：画画'), true);
  eq('t-3 retracted 不注入', p.includes('冷光'), false);
  eq('t-4 还没确认规则句', p.includes('绝不主动说"我知道你喜欢X"'), true);
}

console.log(`\nrecall-provenance tests: pass=${pass} fail=${fail} tmp=${tmp}`);
if (fail > 0) process.exit(1);
