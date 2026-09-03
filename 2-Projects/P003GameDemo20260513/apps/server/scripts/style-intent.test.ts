/**
 * 语音调档 Phase A 回归测试 · 跑法：NODE_OPTIONS=--experimental-sqlite tsx scripts/style-intent.test.ts
 * 覆盖：S1 词表正负语料（≥30 句）/ 归一 / 第三人称与否定排除 / observe 不写表 / execute 切档+来源+账本 rule /
 * 防抖（同档、10 分钟冷却、每日 3 次）/ off 模式 noop / 家长 PUT 仍记 parent 来源。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'style-intent-test-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');

const { detectStyleIntent, normalizeForIntent, applyVoiceStyle, _resetVoiceStyleState, VOICE_STYLE_COOLDOWN_MS, VOICE_STYLE_DAILY_MAX } =
  await import('../src/style-intent.js');
const { traitStore } = await import('../src/trait-store.js');
const { growthLedgerStore } = await import('../src/growth-ledger-store.js');

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`FAIL ${name} got=${g} want=${w}`); }
}
function ok(name: string, cond: boolean): void { if (cond) pass += 1; else { fail += 1; console.error(`FAIL ${name}`); } }

// ── 归一 ──
eq('norm-1 标点空白全角', normalizeForIntent('小可， 你说 少一点！！'), '小可你说少一点');

// ── S1 正向语料（key）──
const POS: Array<[string, string]> = [
  ['小可你话太多了', 'quiet'], ['你说少一点', 'quiet'], ['少说点', 'quiet'], ['你能不能简短点', 'quiet'],
  ['安静一点', 'quiet'], ['别说那么多', 'quiet'], ['你太啰嗦了', 'quiet'], ['别一直说', 'quiet'],
  ['可不可以说少一点', 'quiet'], ['好不好搞笑一点', 'funny'], ['小可你能不能多说一点', 'chatty'],
  ['你多说一点嘛', 'chatty'], ['多聊点', 'chatty'], ['别那么闷', 'chatty'], ['多陪我聊聊', 'chatty'], ['话多一点', 'chatty'],
  ['搞笑一点', 'funny'], ['你幽默点', 'funny'], ['活泼一点好不好', 'funny'], ['有趣点', 'funny'], ['皮一点', 'funny'],
  ['恢复原来的样子', 'default'], ['别搞笑了', 'default'], ['正常一点', 'default'], ['好好说话', 'default'], ['像以前那样', 'default'],
];
for (const [text, key] of POS) eq(`pos「${text}」`, detectStyleIntent(text)?.key ?? null, key);

// ── S1 负向语料（必须 null：无诉求 / 第三人称 / 否定 / 内容诉求）──
const NEG = [
  '我妈妈话太多了', '小明让你安静点', '老师说我话太多', '他太啰嗦了',
  '我不要你安静', '不用说少一点', '我不想你搞笑', '别安静',
  '给我讲个笑话', '今天天气太闷了', '恐龙为什么灭绝', '我想听故事',
  '我爸爸让我多说一点', '姐姐说你好玩', '', '你好呀',
];
for (const text of NEG) eq(`neg「${text}」`, detectStyleIntent(text), null);
ok('语料量 ≥30', POS.length + NEG.length >= 30);
eq('hit 形状', detectStyleIntent('你说少一点'), { key: 'quiet', matched: '说少一点', lane: 'S1' });

// ── 处置：observe 不写表 ──
const ACC = 'device-BJP00326060100009999';
const hitQuiet = detectStyleIntent('小可你说少一点')!;
_resetVoiceStyleState();
eq('obs-1 observe 只记不切', applyVoiceStyle(ACC, hitQuiet, '小可你说少一点', 'observe', 1_700_000_000_000).outcome, 'observed');
eq('obs-2 模板未动', traitStore.getTemplate(ACC), null);
eq('off-1 off=noop', applyVoiceStyle(ACC, hitQuiet, 'x', 'off').outcome, 'noop');

// ── 处置：execute 切档 + 来源 + 账本 rule + policy 行 ──
const T0 = 1_700_000_000_000;
const r1 = applyVoiceStyle(ACC, hitQuiet, '小可你说少一点', 'execute', T0);
eq('exe-1 executed', r1.outcome, 'executed');
eq('exe-2 模板=quiet', traitStore.getTemplate(ACC), 'quiet');
eq('exe-3 来源=voice', traitStore.getTemplateSource(ACC), 'voice');
eq('exe-4 特质置位 talkativeness=0.15', Number(traitStore.get(ACC).talkativeness.toFixed(2)), 0.15);
ok('exe-5 policy 行含答应指令', (r1.policyLine ?? '').includes('先用一句话') && (r1.policyLine ?? '').includes('安静小可'));
const evs = growthLedgerStore.list(ACC, { limit: 50 }).filter((e: any) => e.rule === 'child_voice_style');
ok('exe-6 账本 rule=child_voice_style 且 note 带孩子原话', evs.length >= 1 && evs.every((e: any) => String(e.note).includes('孩子说「小可你说少一点」')));
ok('exe-7 无 parent_style_template 记账', growthLedgerStore.list(ACC, { limit: 50 }).every((e: any) => e.rule !== 'parent_style_template'));

// ── 防抖 ──
eq('deb-1 同档 suppressed', applyVoiceStyle(ACC, hitQuiet, 'x', 'execute', T0 + 1000).reason, 'same_template');
const hitFunny = detectStyleIntent('搞笑一点')!;
eq('deb-2 10 分钟内换档=cooldown', applyVoiceStyle(ACC, hitFunny, 'x', 'execute', T0 + VOICE_STYLE_COOLDOWN_MS - 1).reason, 'cooldown');
eq('deb-3 冷却后可切', applyVoiceStyle(ACC, hitFunny, '搞笑一点', 'execute', T0 + VOICE_STYLE_COOLDOWN_MS).outcome, 'executed');
eq('deb-4 模板=funny', traitStore.getTemplate(ACC), 'funny');
const hitChatty = detectStyleIntent('多说一点')!;
eq('deb-5 第三次仍可', applyVoiceStyle(ACC, hitChatty, 'x', 'execute', T0 + 2 * VOICE_STYLE_COOLDOWN_MS).outcome, 'executed');
eq('deb-6 第四次=daily_cap', applyVoiceStyle(ACC, hitQuiet, 'x', 'execute', T0 + 3 * VOICE_STYLE_COOLDOWN_MS).reason, 'daily_cap');
eq('deb-7 每日上限常量=3', VOICE_STYLE_DAILY_MAX, 3);
eq('deb-8 次日重置', applyVoiceStyle(ACC, hitQuiet, 'x', 'execute', T0 + 86_400_000 + 3 * VOICE_STYLE_COOLDOWN_MS).outcome, 'executed');

// ── 家长 PUT 仍是 parent 来源（默认参数） ──
const ACC2 = 'device-BJP00326060100009998';
traitStore.setTemplate(ACC2, 'funny');
eq('par-1 默认来源 parent', traitStore.getTemplateSource(ACC2), 'parent');
ok('par-2 账本 rule 仍 parent_style_template', growthLedgerStore.list(ACC2, { limit: 20 }).some((e: any) => e.rule === 'parent_style_template'));
traitStore.setTemplate(ACC2, 'default', { source: 'voice', quote: '恢复原来' });
eq('par-3 语音恢复默认=模板清空', traitStore.getTemplate(ACC2), null);

console.log(`\nstyle-intent tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
