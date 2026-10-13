/**
 * 内容型长输出（讲故事/科普）长度豁免说话风格 · 跑法：cd apps/server && npm run test:story-length
 * 背景（2026-09-14 …0010 实测）：quiet 模板「不超过两句/讲完即收」+ 话语量 0.15 排在基座「讲故事 200-500 字分段」之后，
 * 模型把故事压到 87-269 字并停在悬念句（"我……我可以帮忙吗？"）。原则：说话风格只管日常对话怎么说，内容型长输出的长度由内容决定。
 * 断言：① 基座故事规则改写；② quiet 模板注入时豁免句紧跟模板之后（recency）；③ 特质行注入时同样带豁免；
 *      ④ 无模板无特质的账号不出现豁免句（负锚：证明条件分支真的在跑，而不是常量恒在）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'story-len-test-'));
for (const k of ['PROFILE_DB_PATH', 'DEVICES_DB_PATH', 'FEEDBACK_DB_PATH', 'CONVERSATION_DB_PATH', 'CONFIG_DB_PATH', 'ACCOUNTS_DB_PATH']) {
  process.env[k] = join(tmp, `${k.toLowerCase()}.db`);
}
delete process.env.PERSONA_TRAIT_ENABLED;
delete process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST;

const { assembleSystemPrompt } = await import('../src/prompt-orchestrator.js');
const { traitStore } = await import('../src/trait-store.js');
const { ARK_WORLDVIEW_BASE } = await import('../src/prompts.js');
const { STYLE_TEMPLATES, CONTENT_LENGTH_EXEMPTION } = await import('../src/style-template.js');

let pass = 0, fail = 0;
function ok(name: string, cond: boolean): void { if (cond) pass += 1; else { fail += 1; console.error(`FAIL ${name}`); } }
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`FAIL ${name} got=${g} want=${w}`); }
}
const count = (s: string, needle: string): number => s.split(needle).length - 1;

// ── ① 基座故事规则（prompts.ts【说话方式】）──
const base = ARK_WORLDVIEW_BASE;
ok('base-1 内容型长输出长度由内容决定', base.includes('长度由内容决定'));
ok('base-2 一次讲完整(有开头经过结尾)', base.includes('一次讲完整'));
ok('base-3 孩子说长一点 → 400-600 字', base.includes('400-600'));
ok('base-4 不停在悬念句/人物台词', base.includes('不要停在悬念句或人物台词上'));
ok('base-5 分次讲时段末要问', base.includes('要不要继续听'));
ok('base-6 旧措辞「200-500 字分段」已移除', !base.includes('200-500 字分段'));
ok('base-7 日常 30-50 字仍在', base.includes('30-50 字'));

// ── ② quiet 模板账号：豁免句紧跟模板规则之后 ──
const ACC_Q = 'test-story-quiet';
traitStore.setTemplate(ACC_Q, 'quiet');
const pq = assembleSystemPrompt(base, null, { accountId: ACC_Q, role: 'device' });
const iRule = pq.indexOf(STYLE_TEMPLATES.quiet.styleRule);
const iEx = pq.indexOf(CONTENT_LENGTH_EXEMPTION);
ok('quiet-1 模板规则已注入', iRule >= 0);
ok('quiet-2 豁免句已注入', iEx >= 0);
ok('quiet-3 豁免句在模板规则之后(recency)', iEx > iRule);
ok('quiet-4 豁免句在基座故事规则之后', iEx > pq.indexOf('一次讲完整'));
eq('quiet-5 豁免句只出现一次', count(pq, CONTENT_LENGTH_EXEMPTION), 1);
ok('quiet-6 豁免句点名内容型长输出且不因安静讲短', CONTENT_LENGTH_EXEMPTION.includes('讲故事') && CONTENT_LENGTH_EXEMPTION.includes('安静'));

// ── ③ 特质行账号（无模板，PERSONA_TRAIT_ENABLED=1 + allowlist）：豁免句同样在 ──
const ACC_T = 'test-story-trait';
process.env.PERSONA_TRAIT_ENABLED = '1';
process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST = ACC_T;
const pt = assembleSystemPrompt(base, null, { accountId: ACC_T, role: 'device' });
ok('trait-1 话语量行已注入', pt.includes('话语量:'));
ok('trait-2 豁免句已注入', pt.includes(CONTENT_LENGTH_EXEMPTION));
ok('trait-3 豁免句在话语量行之后', pt.indexOf(CONTENT_LENGTH_EXEMPTION) > pt.indexOf('话语量:'));
ok('trait-4 无模板时不含模板规则', !pt.includes('【说话风格·家长设定'));
delete process.env.PERSONA_TRAIT_ENABLED;
delete process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST;

// ── ④ 负锚：无模板无特质 → 无豁免句（但基座规则仍在）──
const ACC_N = 'test-story-none';
const pn = assembleSystemPrompt(base, null, { accountId: ACC_N, role: 'device' });
ok('none-1 无模板无特质 → 不注入豁免句', !pn.includes(CONTENT_LENGTH_EXEMPTION));
ok('none-2 基座故事规则仍在', pn.includes('一次讲完整'));

// ── 清理 + 三模板都不含“讲短”类硬约束以外的额外故事限制（chatty/funny 不应反向要求短）──
traitStore.clearTemplate(ACC_Q);
ok('tpl-1 quiet 模板仍保留两句约束(日常对话)', STYLE_TEMPLATES.quiet.styleRule.includes('不超过两句话'));

console.log(`story-length-exemption: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
console.log('🎉 内容型长输出长度豁免说话风格 全部通过');
