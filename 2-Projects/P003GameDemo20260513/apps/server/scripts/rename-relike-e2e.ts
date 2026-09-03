/**
 * 真 LLM E2E（生产机跑，临时库不碰真实档案）：改称呼口语句式 + 不喜欢撤回/复活，走的就是
 * custom-llm 每轮调用的 extractAndPersist（真抽取模型 + 真硬门 + 真库），只差 SSE 路由那一层（未改）。
 * 跑法(aliyun-hk)：cd /opt/p003/server && set -a; . ./.env.local; set +a; \
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/rename-relike-e2e.ts
 * 判据全部认库里的终态（档案 nickname / active 不喜欢 / 兴趣 / 账本 rule），不认「没报错」。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'rename-relike-e2e-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');

const { extractAndPersist } = await import('../src/memory-extractor.js');
const { profileStore } = await import('../src/profile-store.js');
const { memoryItemStore } = await import('../src/memory-item-store.js');
const { growthLedgerStore } = await import('../src/growth-ledger-store.js');

const ACCT = 'e2e-rename-relike';
const U = (t: string) => ({ role: 'user' as const, content: t });
const A = (t: string) => ({ role: 'assistant' as const, content: t });
let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass += 1;
    console.log(`✅ ${name} = ${g}`);
  } else {
    fail += 1;
    console.log(`❌ ${name} got=${g} want=${w}`);
  }
}
const nick = () => profileStore.getProfile(ACCT)?.nickname;
const interests = () => profileStore.getProfile(ACCT)?.interests.map((i) => i.value) ?? [];
const dislikes = () => memoryItemStore.listActiveDislikes(ACCT).map((d) => d.content);
const rules = () => growthLedgerStore.list(ACCT, { module: 'profile' }).map((e) => e.rule);

profileStore.upsertBasics(ACCT, { nickname: '小明', gender: '男孩' });
const t0 = Date.now();

await extractAndPersist(ACCT, [U('叫我小川'), A('好呀，小川！')], 'e2e');
check('1 裸句式「叫我小川」→ 档案改名', nick(), '小川');

await extractAndPersist(ACCT, [U('你可以叫我大王'), A('好的，大王！')], 'e2e');
check('2 「你可以叫我大王」→ 改名', nick(), '大王');

await extractAndPersist(ACCT, [U('哎子贤'), A('嗯？子贤是谁呀')], 'e2e');
check('3 呼喊第三人「哎子贤」→ 不改（8-26 实案回归）', nick(), '大王');

await extractAndPersist(ACCT, [U('我叫妈妈来吃饭'), A('好的')], 'e2e');
check('4 「我叫妈妈来吃饭」→ 不改', nick(), '大王');

await extractAndPersist(ACCT, [U('我特别喜欢恐龙'), A('恐龙真棒！')], 'e2e');
check('5 喜欢恐龙 → 兴趣', interests().includes('恐龙'), true);

await extractAndPersist(ACCT, [U('我特别喜欢恐龙'), A('恐龙真棒！'), U('我不喜欢恐龙了'), A('好的，那我们聊别的')], 'e2e');
check('6 不喜欢恐龙了 → 不喜欢 active', dislikes(), ['不喜欢恐龙']);
check('6b 兴趣里恐龙被删', interests().includes('恐龙'), false);

await extractAndPersist(ACCT, [U('我不喜欢恐龙了'), A('好的，那我们聊别的'), U('我又喜欢恐龙了'), A('太好了！')], 'e2e');
check('7 又喜欢恐龙了 → 不喜欢撤回', dislikes(), []);
check('7b 兴趣加回恐龙', interests().includes('恐龙'), true);
check('7c 账本 explicit_relike', rules().includes('explicit_relike'), true);

await extractAndPersist(ACCT, [U('我又喜欢恐龙了'), A('太好了！'), U('我们玩个游戏吧'), A('好呀')], 'e2e');
check('8 陈旧窗口重抽不复活不喜欢', dislikes(), []);
check('8b 兴趣仍在', interests().includes('恐龙'), true);

await extractAndPersist(ACCT, [U('我们玩个游戏吧'), A('好呀'), U('我又不喜欢恐龙了'), A('好吧')], 'e2e');
check('9 又不喜欢 → 复活', dislikes(), ['不喜欢恐龙']);
check('9b 账本 dislike_restated', rules().includes('dislike_restated'), true);

console.log(`\nrename-relike-e2e: pass=${pass} fail=${fail} 耗时=${Math.round((Date.now() - t0) / 1000)}s 临时库=${tmp}`);
memoryItemStore.deleteByAccountId(ACCT);
process.exit(fail > 0 ? 1 : 0);
