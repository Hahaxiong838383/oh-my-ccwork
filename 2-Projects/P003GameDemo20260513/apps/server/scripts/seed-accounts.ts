// Step 0 seed：10 个固定测试账号 + 邀请码（原型 mock 登录用）。幂等，可重复跑。
// 跑法（在 apps/server 下）：../../node_modules/.bin/tsx scripts/seed-accounts.ts
// 不接入任何运行路由，只灌 accounts.db；对现有 admin 登录 / 语音体验零影响。见 docs/15 §6 Step 0。
import { accountStore, type AccountSeed } from '../src/account-store.js';

// 10 个固定账号 + 邀请码（码写死=幂等；KH-xxxx 形式，发给测试家长）。
const SEED: AccountSeed[] = [
  { id: 'acct-01', nickname: '测试家长01', code: 'KH-9K2M' },
  { id: 'acct-02', nickname: '测试家长02', code: 'KH-4R7T' },
  { id: 'acct-03', nickname: '测试家长03', code: 'KH-8W3X' },
  { id: 'acct-04', nickname: '测试家长04', code: 'KH-2P6L' },
  { id: 'acct-05', nickname: '测试家长05', code: 'KH-5N1V' },
  { id: 'acct-06', nickname: '测试家长06', code: 'KH-7B9D' },
  { id: 'acct-07', nickname: '测试家长07', code: 'KH-3H4F' },
  { id: 'acct-08', nickname: '测试家长08', code: 'KH-6Q8S' },
  { id: 'acct-09', nickname: '测试家长09', code: 'KH-1Z5C' },
  { id: 'acct-10', nickname: '测试家长10', code: 'KH-0J7G' },
];

accountStore.seed(SEED);

const accounts = accountStore.listAccounts();
const codes = accountStore.listCodes();
console.log(`[seed-accounts] account=${accounts.length} 行, invite_code=${codes.length} 行`);
for (const c of codes) {
  const a = accounts.find((x) => x.id === c.account_id);
  console.log(`  ${c.code}  →  ${c.account_id} (${a?.nickname ?? '?'})  used_at=${c.used_at ?? '未用'}`);
}
