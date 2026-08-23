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

const { profileStore, normalizeInterestValue, isSameInterest } = await import('../src/profile-store.js');
const { filterInterestsAgainstDislikes } = await import('../src/memory-extractor.js');

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
  eq('r-1 retract 散文删掉同义兴趣', { removed, left: p.interests.map((i) => i.value) }, { removed: true, left: ['恐龙'] });
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

console.log(`\ninterests.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
