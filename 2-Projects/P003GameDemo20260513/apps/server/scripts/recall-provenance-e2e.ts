/**
 * 真 LLM E2E（生产机、临时库）：R2 证据链 + L2 到期核对，走 extractAndPersist 真链（真抽取模型 + 真门 + 真库）。
 * 跑法(aliyun-hk)：cd /opt/p003/server && set -a; . ./.env.local; set +a; \
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/recall-provenance-e2e.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'recall-prov-e2e-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.CONVERSATION_DB_PATH = join(tmp, 'conversation.db');

const { extractAndPersist } = await import('../src/memory-extractor.js');
const { profileStore } = await import('../src/profile-store.js');
const { memoryItemStore } = await import('../src/memory-item-store.js');
const { conversationStore } = await import('../src/conversation-store.js');
const { growthLedgerStore } = await import('../src/growth-ledger-store.js');
const { assembleSystemPrompt } = await import('../src/prompt-orchestrator.js');

const ACC = 'device-E2EPROV0001';
let pass = 0; let fail = 0;
const check = (name: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log(`✅ ${name} = ${g}`); } else { fail++; console.log(`❌ ${name} got=${g} want=${w}`); } };
profileStore.upsertBasics(ACC, { nickname: '小明', gender: '男孩' });
const t0 = Date.now();

// 1) 落库两条消息拿 id，快照带 id → 条目 source_msg_id 指回
const u1 = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'user', text: '我昨天和爸爸去了海洋馆，最喜欢白鲸' });
const a1 = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'assistant', text: '哇，白鲸真可爱！那说好了，明天小可给你讲一个白鲸的故事。' });
const u2 = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'user', text: '好，明天你一定要讲白鲸的故事' });
const a2 = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'assistant', text: '一定！明天见。' });
await extractAndPersist(ACC, [
  { role: 'user', content: u1.text, id: u1.id }, { role: 'assistant', content: a1.text, id: a1.id },
  { role: 'user', content: u2.text, id: u2.id }, { role: 'assistant', content: a2.text, id: a2.id },
], 'e2e');
console.log('   抽出条目类型=' + JSON.stringify(memoryItemStore.listByAccount(ACC).items.map((i) => i.type + ':' + i.content.slice(0, 12))));
{
  const items = memoryItemStore.listByAccount(ACC).items;
  const ev = items.find((i) => i.type === 'event');
  const pr = items.find((i) => i.type === 'promise');
  check('1 抽出经历', !!ev, true);
  check('1b 经历 source_msg_id=孩子那条消息', ev?.source_msg_id, u1.id);
  check('2 抽出小可约定', !!pr, true);
  check('2b 约定 source_msg_id=小可那条消息', pr ? [a1.id, a2.id].includes(pr.source_msg_id) : false, true);
  const expect = (() => { try { return String((JSON.parse(pr?.meta || '{}') as { expect?: unknown }).expect ?? ''); } catch { return ''; } })();
  console.log('   约定 expect=' + JSON.stringify(expect) + ' due=' + pr?.due_text);
  check('2c 约定 valid_from 有值', typeof pr?.valid_from, 'number');
}
// 2) 性格/情绪覆盖记旧值（账本 profile_field_update）
await extractAndPersist(ACC, [
  { role: 'user', content: '我今天考试没考好，有点难过', id: conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'user', text: '我今天考试没考好，有点难过' }).id },
  { role: 'assistant', content: '没关系，下次一定可以的' },
], 'e2e');
{
  const led = growthLedgerStore.list(ACC, { module: 'profile' });
  console.log('   profile 账本 rules=' + JSON.stringify(led.map((e) => e.rule + ':' + e.dimension)));
  check('3 情绪/性格更新有账本旧值记录', led.some((e) => e.rule === 'profile_field_update'), true);
}
// 3) 到期核对渲染：把约定 due 改成今天后看 prompt
{
  const pr = memoryItemStore.listByAccount(ACC).items.find((i) => i.type === 'promise');
  if (pr) {
    const end = new Date(); end.setHours(23, 59, 59, 0);
    (memoryItemStore as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare('UPDATE memory_item SET due_at = ?, meta = ? WHERE id = ?').run(end.getTime(), JSON.stringify({ expect: '听白鲸故事' }), pr.id);
  }
  const p = assembleSystemPrompt('BASE', null, { accountId: ACC, role: 'device' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  check('4 到期约定带核对', p.includes('到期核对="听白鲸故事"'), true);
  check('4b 核对规则句', p.includes('带「到期核对」的约定'), true);
}
console.log(`\nrecall-provenance-e2e: pass=${pass} fail=${fail} 耗时=${Math.round((Date.now() - t0) / 1000)}s`);
memoryItemStore.deleteByAccountId(ACC);
process.exit(fail > 0 ? 1 : 0);
