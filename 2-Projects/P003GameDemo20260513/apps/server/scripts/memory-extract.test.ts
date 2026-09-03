/**
 * 称呼抽取硬门回归测试 · 跑法：npm run test:memory-extract（tsx 直跑，无框架，风格同 local-audio.test）
 * 背景（2026-08-26 生产实案）：川哥在 003 喊了一声「哎子贤」（呼喊第三人），抽取 LLM 把它当自报
 * 姓名写进 nickname，跨会话固化——prompt 约束 LLM 不守，服务端必须有语义硬门（五门，模式复刻
 * promise evidence 硬校验）。本测试锚死每一道门。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memx-test-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');

const { parsePatch } = await import('../src/memory-extractor.js');
import type { FamilyMember } from '../src/profile-store.js';

let pass = 0,
  fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got),
    w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name} got=${g} want=${w}`);
  }
}
function ok(name: string, cond: boolean): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name}`);
  }
}

const CUR: FamilyMember = {
  id: 'fm-test', account_id: 'device-TEST', nickname: '川哥', birthday: '', gender: '男孩',
  interests: [], preferred_address: '', personality_notes: '', recent_emotion: '',
  game_progress: [], created_at: 0, updated_at: 0,
};
const U = (t: string) => ({ role: 'user' as const, content: t });
const A = (t: string) => ({ role: 'assistant' as const, content: t });
const raw = (v: string, ev: string) => JSON.stringify({ nickname_change: { value: v, evidence: ev } });

// ── 负锚（每一道门单独打红）──
// ①「哎子贤」实案：evidence 真实存在但不是改名意图（呼喊第三人）
eq('nk-1 呼喊他人名不改（实案回归）', parsePatch(raw('子贤', '哎子贤'), CUR, [U('哎子贤'), A('好呀')]), null);
// ② evidence 编造：对话里根本没这句
eq('nk-2 evidence 不在对话里拒', parsePatch(raw('小明', '以后叫我小明'), CUR, [U('今天天气不错')]), null);
// ③ evidence 是小可说的不是孩子说的（只认 user 消息）
eq('nk-3 小可的话不算孩子意图', parsePatch(raw('小明', '以后叫我小明'), CUR, [A('以后叫我小明'), U('好')]), null);
// ④ value 不在 evidence 里（拿 A 句证据填 B 值）
eq('nk-4 值证不符拒', parsePatch(raw('小红', '以后叫我小明'), CUR, [U('以后叫我小明')]), null);
// ⑤ 提及他人（「我叫妈妈来吃饭」不是改名——裸「我叫」故意不在句式集）
eq('nk-5 我叫妈妈来≠改名', parsePatch(raw('妈妈', '我叫妈妈来吃饭'), CUR, [U('我叫妈妈来吃饭')]), null);
// ⑥ 代词黑名单
eq('nk-6 代词「你」拒', parsePatch(raw('你', '以后叫我你'), CUR, [U('以后叫我你')]), null);
// ⑦ AI 名黑名单
eq('nk-7 「小可」拒', parsePatch(raw('小可', '以后叫我小可'), CUR, [U('以后叫我小可')]), null);
// ⑧ 与现名相同不重写
eq('nk-8 同名不写', parsePatch(raw('川哥', '以后叫我川哥'), CUR, [U('以后叫我川哥')]), null);
// ⑨ 旧 schema 平铺 nickname 字段不再被认（切换即失效，无兼容路径可绕门）
eq('nk-9 旧字段 nickname 忽略', parsePatch(JSON.stringify({ nickname: '子贤' }), CUR, [U('哎子贤')]), null);
// ⑩ 缺 evidence 结构拒
eq('nk-10 缺 evidence 拒', parsePatch(JSON.stringify({ nickname_change: { value: '小明' } }), CUR, [U('以后叫我小明')]), null);

// ── 正锚（显式意图全链绿，负锚才有意义）──
const p1 = parsePatch(raw('小川', '以后叫我小川吧'), CUR, [U('以后叫我小川吧')]);
eq('nk-11 「以后叫我X」过', p1?.nickname, '小川');
eq('nk-12 evidence 随行供记账', p1?.nickname_evidence, '以后叫我小川吧');
const p2 = parsePatch(raw('大王', '请叫我大王'), CUR, [U('请叫我大王'), A('好的大王')]);
eq('nk-13 「请叫我X」过', p2?.nickname, '大王');
const p3 = parsePatch(raw('阿川', '我想改名叫阿川'), CUR, [U('我想改名叫阿川')]);
eq('nk-14 「我想改名叫X」过', p3?.nickname, '阿川');

// ── 其他字段不受门影响 ──
const p4 = parsePatch(JSON.stringify({ interests: ['恐龙'] }), CUR, [U('我喜欢恐龙')]);
eq('nk-15 兴趣链路不受影响', p4?.interests?.[0]?.value, '恐龙');

console.log(`\nmemory-extract tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
