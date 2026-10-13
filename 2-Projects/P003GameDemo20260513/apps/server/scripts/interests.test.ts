/**
 * 兴趣污染治理回归测试 · 跑法：npm run test:interests（tsx 直跑，无框架）
 * 覆盖（2026-08-23 方案 B）：归一判定 / append 互含判重 / removeInterest 包含删 / dislike 对撞过滤
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'interests-test-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.ACCOUNTS_DB_PATH = join(tmp, 'accounts.db');

const { profileStore, normalizeInterestValue, isSameInterest, activeInterests, interestState } = await import('../src/profile-store.js');
const { filterInterestsAgainstDislikes, parsePatch } = await import('../src/memory-extractor.js');

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1;
  else { fail += 1; console.error(`FAIL ${name} got=${g} want=${w}`); }
}

// ---------- 归一与同义判定 ----------
eq('n-1 归一去分隔', normalizeInterestValue('KET/PET考试'), 'ketpet考试');
eq('n-2 变体同义', isSameInterest('KET/PET考试', 'KETPET'), true);
eq('n-3 组合串同义', isSameInterest('KET/PET考试/KETPET', 'KETPET'), true);
eq('n-4 散文含短词', isSameInterest('不喜欢不想聊冷光', '冷光'), true);
eq('n-5 无关不同义', isSameInterest('恐龙', '奥特曼'), false);
eq('n-6 空串不匹配', isSameInterest('//', '恐龙'), false);

// ---------- append 互含判重（经 updateMemoryFields 真链路）----------
const now = Date.now();
const it = (v: string) => ({ value: v, confidence: 0.8, last_updated: now, source: 'voice' });
profileStore.upsertProfile('acct-t', { nickname: '测试', birthday: '', gender: '' });
profileStore.updateMemoryFields('acct-t', { interests: [it('KET/PET考试')] });
profileStore.updateMemoryFields('acct-t', { interests: [it('KETPET')] }); // 同义应拒
profileStore.updateMemoryFields('acct-t', { interests: [it('KET/PET考试/KETPET')] }); // 组合串应拒
profileStore.updateMemoryFields('acct-t', { interests: [it('恐龙')] }); // 新义应收
{
  const p = profileStore.getProfile('acct-t')!;
  eq('a-1 同义变体全拒仅存首个+新义', p.interests.map((i) => i.value), ['KET/PET考试', '恐龙']);
}

// ---------- removeInterest 包含删 ----------
{
  const removed = profileStore.removeInterest('acct-t', '不想聊KET/PET考试了');
  const p = profileStore.getProfile('acct-t')!;
  eq('r-1 retract 散文撤回同义兴趣(软撤回,active 视图消失)', { removed, left: activeInterests(p.interests).map((i) => i.value) }, { removed: true, left: ['恐龙'] });
  eq('r-2 无匹配返回 false', profileStore.removeInterest('acct-t', '汽车'), false);
}

// ---------- dislike 对撞过滤（纯函数）----------
{
  const kept = filterInterestsAgainstDislikes(
    [it('冷光'), it('恐龙')],
    ['不喜欢不想聊冷光', '不喜欢写作业'],
  );
  eq('d-1 dislike 命中拦截', kept.map((i) => i.value), ['恐龙']);
  eq('d-2 空 dislike 全通过', filterInterestsAgainstDislikes([it('画画')], []).length, 1);
}

// ---------- R1 证据化 / 三态 / 否决（2026-09-03）----------
{
  const cur = profileStore.getProfile('acct-t')!;
  const H = (t: string) => [{ role: 'user' as const, content: t }];
  eq('v-1 裸字符串(旧 schema)无证据不收', parsePatch(JSON.stringify({ interests: ['汽车'] }), cur, H('我喜欢汽车')), null);
  eq('v-2 证据不在原话里不收', parsePatch(JSON.stringify({ interests: [{ value: '汽车', evidence: '我最爱汽车' }] }), cur, H('今天天气不错')), null);
  eq('v-3 证据不含 value 不收', parsePatch(JSON.stringify({ interests: [{ value: '海洋生物', evidence: '我喜欢白鲸' }] }), cur, H('我喜欢白鲸')), null);
  const ok = parsePatch(JSON.stringify({ interests: [{ value: '汽车', evidence: '我最喜欢汽车了' }] }), cur, H('我最喜欢汽车了真的'));
  eq('v-4 有证据→unverified+evidence+当天提及日', [ok?.interests?.[0]?.state, ok?.interests?.[0]?.evidence, ok?.interests?.[0]?.mention_days?.length], ['unverified', '我最喜欢汽车了', 1]);
  // 两个不同日子提及 → verified
  profileStore.updateMemoryFields('acct-t', { interests: [{ value: '汽车', confidence: 0.5, last_updated: 1, source: 'voice', evidence: '我最喜欢汽车了', state: 'unverified', mention_days: ['2026-09-01'] }] });
  eq('v-5 首次提及=unverified', interestState(profileStore.getProfile('acct-t')!.interests.find((i) => i.value === '汽车')!), 'unverified');
  profileStore.updateMemoryFields('acct-t', { interests: [{ value: '汽车', confidence: 0.5, last_updated: 2, source: 'voice', state: 'unverified', mention_days: ['2026-09-01'] }] });
  eq('v-6 同一天重复提及仍 unverified', interestState(profileStore.getProfile('acct-t')!.interests.find((i) => i.value === '汽车')!), 'unverified');
  profileStore.updateMemoryFields('acct-t', { interests: [{ value: '汽车', confidence: 0.5, last_updated: 3, source: 'voice', state: 'unverified', mention_days: ['2026-09-03'] }] });
  const car = profileStore.getProfile('acct-t')!.interests.find((i) => i.value === '汽车')!;
  eq('v-7 第二天提及→verified(0.8)', [interestState(car), car.confidence, car.mention_days], ['verified', 0.8, ['2026-09-01', '2026-09-03']]);
  // 家长否决：之后再提也不升
  eq('v-8 家长否决', profileStore.vetoInterest('acct-t', '汽车'), true);
  profileStore.updateMemoryFields('acct-t', { interests: [{ value: '汽车', confidence: 0.5, last_updated: 4, source: 'voice', state: 'unverified', mention_days: ['2026-09-04'] }] });
  const car2 = profileStore.getProfile('acct-t')!.interests.find((i) => i.value === '汽车')!;
  eq('v-9 否决后再提不复活', [interestState(car2), car2.retracted_by], ['retracted', 'parent']);
  // 不喜欢撤回可被重提复活
  profileStore.updateMemoryFields('acct-t', { interests: [{ value: '积木', confidence: 0.5, last_updated: 5, source: 'voice', state: 'unverified', mention_days: ['2026-09-01'] }] });
  eq('v-10 不喜欢撤回', profileStore.removeInterest('acct-t', '积木'), true);
  profileStore.updateMemoryFields('acct-t', { interests: [{ value: '积木', confidence: 0.5, last_updated: 6, source: 'voice', state: 'unverified', mention_days: ['2026-09-05'] }] });
  const lego = profileStore.getProfile('acct-t')!.interests.find((i) => i.value === '积木')!;
  eq('v-11 重提复活(且两天→verified)', [interestState(lego), lego.retracted_by ?? null], ['verified', null]);
  eq('v-12 物理删除', [profileStore.deleteInterest('acct-t', '积木'), profileStore.getProfile('acct-t')!.interests.some((i) => i.value === '积木')], [true, false]);
}

console.log(`\ninterests.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
