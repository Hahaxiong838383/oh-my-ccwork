/**
 * 真 LLM E2E（生产机、临时库）：R1 兴趣证据化——抽取器交 {value,evidence}，服务端硬门，三态升格，注入分级，家长否决。
 * 跑法(aliyun-hk)：cd /opt/p003/server && set -a; . ./.env.local; set +a; NODE_OPTIONS=--experimental-sqlite npx tsx scripts/interests-evidence-e2e.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmp = mkdtempSync(join(tmpdir(), 'interests-e2e-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.CONVERSATION_DB_PATH = join(tmp, 'conversation.db');
const { extractAndPersist } = await import('../src/memory-extractor.js');
const { profileStore, interestState } = await import('../src/profile-store.js');
const { conversationStore } = await import('../src/conversation-store.js');
const { assembleSystemPrompt } = await import('../src/prompt-orchestrator.js');
const ACC = 'device-E2EINT0001';
let pass = 0; let fail = 0;
const check = (name: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) { pass++; console.log(`✅ ${name} = ${g}`); } else { fail++; console.log(`❌ ${name} got=${g} want=${w}`); } };
profileStore.upsertBasics(ACC, { nickname: '小明', gender: '男孩' });
const t0 = Date.now();
const say = async (u: string, a: string) => {
  const um = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'user', text: u });
  const am = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'assistant', text: a });
  await extractAndPersist(ACC, [{ role: 'user', content: u, id: um.id }, { role: 'assistant', content: a, id: am.id }], 'e2e');
  return um.id;
};
const uid = await say('我最喜欢恐龙了，霸王龙最厉害！', '哇，霸王龙确实很厉害！');
{
  const it = profileStore.getProfile(ACC)!.interests.find((i) => /恐龙|霸王龙/.test(i.value));
  console.log('   抽出兴趣=' + JSON.stringify(profileStore.getProfile(ACC)!.interests.map((i) => [i.value, i.state, i.evidence])));
  check('1 抽出恐龙类兴趣', !!it, true);
  check('1b 带证据原话', !!it?.evidence && '我最喜欢恐龙了，霸王龙最厉害！'.includes(it!.evidence!), true);
  check('1c 首次=unverified', it ? interestState(it) : null, 'unverified');
  check('1d source_msg_id=孩子那条', it?.source_msg_id, uid);
}
{
  const p = assembleSystemPrompt('BASE', null, { accountId: ACC, role: 'device' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  check('2 单次提及只进「还没确认」行', [p.includes('最近提到过(还没确认是不是真喜欢)'), p.includes('兴趣：')], [true, false]);
}
// 模拟昨天提过：把提及日改成昨天，再提一次 → verified
{
  const prof = profileStore.getProfile(ACC)!;
  const y = new Date(Date.now() - 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  profileStore.updateMemoryFields(ACC, { interests: [] });
  (profileStore as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
    .prepare('UPDATE family_member SET interests = ? WHERE account_id = ?')
    .run(JSON.stringify(prof.interests.map((i) => ({ ...i, mention_days: [y] }))), ACC);
  await say('今天又想聊恐龙，我真的太喜欢恐龙了', '好呀，我们聊恐龙！');
  const it = profileStore.getProfile(ACC)!.interests.find((i) => /恐龙/.test(i.value));
  check('3 第二天再提→verified', it ? interestState(it) : null, 'verified');
  const p = assembleSystemPrompt('BASE', null, { accountId: ACC, role: 'device' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  check('3b verified 进「兴趣」行', p.includes('兴趣：'), true);
}
// 家长否决 → 再提不升
{
  check('4 家长否决', profileStore.vetoInterest(ACC, '恐龙'), true);
  await say('我还是最喜欢恐龙', '恐龙真棒');
  const it = profileStore.getProfile(ACC)!.interests.find((i) => /恐龙/.test(i.value));
  check('4b 否决后再提仍 retracted(parent)', [it ? interestState(it) : null, it?.retracted_by], ['retracted', 'parent']);
  const p = assembleSystemPrompt('BASE', null, { accountId: ACC, role: 'device' } as never, null, null, null, null, null, { skipInjectReceipt: true });
  check('4c 否决后不注入', /兴趣：.*恐龙|还没确认.*恐龙/.test(p), false);
}
{
  const { extractionLogStore } = await import('../src/extraction-log-store.js');
  const rows = extractionLogStore.list(ACC, 10);
  check('5 每轮都有抽取流水', rows.length >= 3, true);
  check('5b 流水带模型耗时与画像字段', rows.some((r) => r.ok === 1 && r.llm_ms > 0 && /interests/.test(r.patch_keys)), true);
  console.log('   流水样例=' + JSON.stringify(rows.slice(0, 2).map((r) => [r.user_len, r.llm_ms, r.patch_keys, r.candidates + '→' + r.added, r.rejected])));
}
console.log(`\ninterests-evidence-e2e: pass=${pass} fail=${fail} 耗时=${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(fail > 0 ? 1 : 0);
