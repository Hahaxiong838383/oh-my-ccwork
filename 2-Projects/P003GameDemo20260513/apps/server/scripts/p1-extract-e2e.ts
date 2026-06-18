// P1 打通生产 E2E：用测试账号验证「语音对话 → 真实 LLM 抽取 → 写 profile 真相源」端到端。
// 模拟孩子说「以后叫我小哪吒，我喜欢恐龙」→ extractMemoryUpdate(真 gemini) → updateMemoryFields。
// 验证后删除测试账号（不污染真实内测用户）。
// 跑法（生产机）：cd /opt/p003/server && NODE_OPTIONS=--experimental-sqlite NO_PROXY=* \
//   ./node_modules/.bin/tsx --env-file=.env.local scripts/p1-extract-e2e.ts
import { profileStore } from '../src/profile-store.js';
import { extractMemoryUpdate } from '../src/memory-extractor.js';

const ACCT = 'test-p1-prod-verify';

async function main() {
  profileStore.deleteByAccountId(ACCT); // 清残留
  profileStore.upsertProfile(ACCT, { nickname: '测试娃', birthday: '2017-01', gender: '男孩' });

  const history = [
    { role: 'user' as const, content: '小可你好' },
    { role: 'assistant' as const, content: '你好呀！很高兴见到你～' },
    { role: 'user' as const, content: '以后叫我小哪吒吧，我最喜欢恐龙了' },
    { role: 'assistant' as const, content: '好的小哪吒！恐龙超酷的～' },
  ];

  const before = profileStore.getProfile(ACCT)!;
  console.log('改名前：nickname=' + before.nickname + ' interests=' + before.interests.map((i) => i.value).join('/'));

  const patch = await extractMemoryUpdate(history, before); // 真实 gemini 抽取
  console.log('LLM 抽取 patch：' + JSON.stringify(patch));
  if (patch) profileStore.updateMemoryFields(ACCT, patch);

  const after = profileStore.getProfile(ACCT)!;
  console.log('改名后：nickname=' + after.nickname + ' interests=' + after.interests.map((i) => i.value).join('/'));

  const ok = after.nickname === '小哪吒' && after.interests.some((i) => i.value === '恐龙');
  profileStore.deleteByAccountId(ACCT); // 清测试账号
  console.log(
    ok
      ? '\n✅ 打通验证 PASS：语音对话 → 真实 LLM 抽取 → 写 profile 真相源（改名「小哪吒」+ 兴趣「恐龙」）'
      : '\n❌ FAIL：抽取/写入未达预期',
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 异常：', e);
  profileStore.deleteByAccountId(ACCT);
  process.exit(2);
});
