/**
 * 「不喜欢」语音撤回单测（dislike-undo + memory-extractor.applyRelikes/revivePreferences）· 跑法：
 *   cd apps/server && NODE_OPTIONS=--experimental-sqlite ../../node_modules/.bin/tsx scripts/dislike-undo.test.ts
 * 临时库（PROFILE_DB_PATH 指向 mkdtemp），不碰生产/开发数据。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'dislike-undo-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');

const { parseRelikes, isFreshDislikeStatement, dislikeSubject } = await import('../src/dislike-undo.js');
const { applyRelikes, revivePreferences, filterInterestsAgainstDislikes, parseEpisodic } = await import('../src/memory-extractor.js');
const { memoryItemStore } = await import('../src/memory-item-store.js');
const { profileStore } = await import('../src/profile-store.js');
const { growthLedgerStore } = await import('../src/growth-ledger-store.js');

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name} got=${g} want=${w}`);
  }
}
const U = (t: string) => ({ role: 'user' as const, content: t });
const A = (t: string) => ({ role: 'assistant' as const, content: t });
const rl = (value: string, evidence: string) => ({ relikes: [{ value, evidence }] });

// ── parseRelikes 四门 ──
eq('r-1 本轮「我又喜欢恐龙了」过', parseRelikes(rl('恐龙', '我又喜欢恐龙了'), [U('我不喜欢恐龙了'), A('好'), U('我又喜欢恐龙了')]).length, 1);
eq('r-2 从「我不喜欢恐龙了」抄出「喜欢恐龙」拒（整句含否定）', parseRelikes(rl('恐龙', '喜欢恐龙'), [U('我不喜欢恐龙了')]).length, 0);
eq('r-3 证据在上一轮不在本轮拒（滑窗只触发一次）', parseRelikes(rl('恐龙', '我又喜欢恐龙了'), [U('我又喜欢恐龙了'), A('好'), U('讲个故事')]).length, 0);
eq('r-4 value 不在证据里拒', parseRelikes(rl('奥特曼', '我又喜欢恐龙了'), [U('我又喜欢恐龙了')]).length, 0);
eq('r-5 证据编造拒', parseRelikes(rl('恐龙', '我又喜欢恐龙了'), [U('今天天气不错')]).length, 0);
eq('r-6 没有喜欢类表达拒', parseRelikes(rl('恐龙', '恐龙很厉害'), [U('恐龙很厉害')]).length, 0);
eq('r-7 「我现在喜欢X了」过', parseRelikes(rl('奥特曼', '我现在喜欢奥特曼了'), [U('我现在喜欢奥特曼了')]).length, 1);
eq('r-8 小可的话不算', parseRelikes(rl('恐龙', '我又喜欢恐龙了'), [A('我又喜欢恐龙了'), U('嗯')]).length, 0);
eq('r-9 非数组容错', parseRelikes({ relikes: 'x' }, [U('我又喜欢恐龙了')]).length, 0);
eq('r-10 isFreshDislikeStatement 正', isFreshDislikeStatement('我又不喜欢恐龙了', '恐龙'), true);
eq('r-11 isFreshDislikeStatement 负（说的是喜欢）', isFreshDislikeStatement('我喜欢恐龙', '恐龙'), false);
eq('r-12 isFreshDislikeStatement 负（不是同一事物）', isFreshDislikeStatement('我不喜欢奥特曼', '恐龙'), false);
eq('r-13 dislikeSubject', dislikeSubject('不喜欢恐龙'), '恐龙');

// ── parseEpisodic 接线：只有 relikes 也不返回 null ──
{
  const ep = parseEpisodic(JSON.stringify(rl('恐龙', '我又喜欢恐龙了')), [U('我又喜欢恐龙了')], { sessionId: 's', activePromises: [] });
  eq('r-14 parseEpisodic 带出 relikes', ep?.relikes.map((r) => r.value), ['恐龙']);
}

// ── 库级闭环（临时库）──
const ACCT = 'test-relike-acct';
memoryItemStore.deleteByAccountId(ACCT);
profileStore.upsertBasics(ACCT, { nickname: '测试', gender: '男孩' });
profileStore.updateMemoryFields(ACCT, { interests: [{ value: '恐龙', confidence: 0.7, last_updated: 1, source: 'voice' }] });
// 方案 B 现状：不喜欢 → preference 条目 + 兴趣删掉 + 之后再抽到「恐龙」被对撞拦住
memoryItemStore.addItems(ACCT, [{ type: 'preference', content: '不喜欢恐龙', session_id: 's', source_role: 'user' }]);
profileStore.removeInterest(ACCT, '恐龙');
eq('d-1 不喜欢 active', memoryItemStore.listActiveDislikes(ACCT).length, 1);
eq('d-2 兴趣已撤回(active 视图为空)', profileStore.getProfile(ACCT)?.interests.filter((i) => (i.state ?? 'unverified') !== 'retracted').length, 0);
eq('d-3 单向门基线：再抽到恐龙被拦', filterInterestsAgainstDislikes([{ value: '恐龙', confidence: 0.7, last_updated: 1, source: 'voice' }], ['不喜欢恐龙']).length, 0);

// 撤回：孩子本轮说「我又喜欢恐龙了」
{
  const cur = profileStore.getProfile(ACCT)!;
  const readd = applyRelikes(ACCT, [{ value: '恐龙', evidence: '我又喜欢恐龙了' }], cur);
  eq('d-4 返回要加回的兴趣', readd.map((i) => i.value), ['恐龙']);
  eq('d-5 不喜欢被撤回（软删）', memoryItemStore.listActiveDislikes(ACCT).length, 0);
  const active = memoryItemStore.listActiveDislikes(ACCT).map((d) => d.content);
  eq('d-6 对撞不再拦', filterInterestsAgainstDislikes(readd, active).length, 1);
  profileStore.updateMemoryFields(ACCT, { interests: readd });
  eq('d-7 兴趣加回(复活为 active)', profileStore.getProfile(ACCT)?.interests.filter((i) => (i.state ?? 'unverified') !== 'retracted').map((i) => i.value), ['恐龙']);
  const led = growthLedgerStore.list(ACCT, { module: 'profile', dimension: 'dislike' });
  eq('d-8 记账 explicit_relike', led.map((e) => e.rule), ['explicit_relike']);
}
// 归一互含：撤回「不喜欢奥特曼」也能命中孩子说「奥特曼玩具」
{
  memoryItemStore.addItems(ACCT, [{ type: 'preference', content: '不喜欢奥特曼', session_id: 's', source_role: 'user' }]);
  const cur = profileStore.getProfile(ACCT)!;
  applyRelikes(ACCT, [{ value: '奥特曼玩具', evidence: '我又喜欢奥特曼玩具了' }], cur);
  eq('d-9 归一互含命中撤回', memoryItemStore.listActiveDislikes(ACCT).length, 0);
}
// 滑窗重抽的陈旧 dislike：本轮原话不是不喜欢 → 不复活、UNIQUE 重插也失败 → 兴趣保住
{
  const stale = [{ type: 'preference' as const, content: '不喜欢恐龙', session_id: 's', source_role: 'user' as const }];
  eq('d-10 陈旧 dislike 不复活', revivePreferences(ACCT, stale, '我们聊聊别的吧'), 0);
  eq('d-11 UNIQUE 阻止重插', memoryItemStore.addItems(ACCT, stale), 0);
  eq('d-12 不喜欢仍撤回状态', memoryItemStore.listActiveDislikes(ACCT).length, 0);
  eq('d-13 兴趣仍在', profileStore.getProfile(ACCT)?.interests.filter((i) => (i.state ?? 'unverified') !== 'retracted').map((i) => i.value), ['恐龙']);
}
// 孩子本轮又明确说不喜欢 → 复活
{
  const fresh = [{ type: 'preference' as const, content: '不喜欢恐龙', session_id: 's2', source_role: 'user' as const }];
  eq('d-14 新鲜原话复活', revivePreferences(ACCT, fresh, '我又不喜欢恐龙了', 's2'), 1);
  eq('d-15 不喜欢重新 active', memoryItemStore.listActiveDislikes(ACCT).map((d) => d.content), ['不喜欢恐龙']);
  const led = growthLedgerStore.list(ACCT, { module: 'profile', dimension: 'dislike' });
  eq('d-16 记账含 dislike_restated', led.some((e) => e.rule === 'dislike_restated'), true);
  eq('d-17 再次复活幂等', revivePreferences(ACCT, fresh, '我又不喜欢恐龙了', 's2'), 0);
}
memoryItemStore.deleteByAccountId(ACCT);

// ── 设备账号无档兜底（所有设备 + 将来新增设备都生效）──
{
  const { ensureDeviceProfile } = await import('../src/memory-extractor.js');
  eq('p-1 非设备账号无档 → null(跳过留痕)', ensureDeviceProfile('acct-web-nobody'), null);
  const made = ensureDeviceProfile('device-TESTSN0001');
  eq('p-2 设备账号无档 → 当场建空档', made ? [made.nickname, made.gender] : null, ['', '']);
  eq('p-3 有档原样返回', ensureDeviceProfile('device-TESTSN0001')?.account_id, 'device-TESTSN0001');
  profileStore.deleteByAccountId('device-TESTSN0001');
}

console.log(`\ndislike-undo tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
