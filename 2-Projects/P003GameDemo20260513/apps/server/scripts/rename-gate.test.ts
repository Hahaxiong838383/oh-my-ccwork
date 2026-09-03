/**
 * 改称呼硬门 v2 单测（rename-gate.checkRenameCandidate）· 跑法：
 *   cd apps/server && NODE_OPTIONS=--experimental-sqlite ../../node_modules/.bin/tsx scripts/rename-gate.test.ts
 * 正锚 = 2026-09-03 生产 conversation.db 近 14 天孩子/川哥真实说法（旧门全部拒）+ 三种句式层级各一；
 * 负锚 = 8-26「哎子贤」实案 + 叫人来 + 转述别人怎么叫 + 动作词 + 黑名单 + 证据编造/错位。
 */
import { checkRenameCandidate, isValidNickname } from '../src/rename-gate.js';

let pass = 0;
let fail = 0;
const U = (t: string) => ({ role: 'user' as const, content: t });
const A = (t: string) => ({ role: 'assistant' as const, content: t });
type H = { role: 'user' | 'assistant'; content: string }[];

function expectOk(name: string, value: string, evidence: string, history: H, tier: 'A' | 'B' | 'C', cur = '川哥'): void {
  const r = checkRenameCandidate(value, evidence, history, cur);
  if (r.ok && r.nickname === value && r.tier === tier) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name} got=${JSON.stringify(r)}`);
  }
}
function expectReject(name: string, value: string, evidence: string, history: H, reason: string, cur = '川哥'): void {
  const r = checkRenameCandidate(value, evidence, history, cur);
  if (!r.ok && r.reason === reason) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name} got=${JSON.stringify(r)} want=${reason}`);
  }
}

// ── 层级 A：显式触发词（旧门也认的三句，回归）──
expectOk('A1 以后叫我X吧', '小川', '以后叫我小川吧', [U('以后叫我小川吧')], 'A');
expectOk('A2 请叫我X', '大王', '请叫我大王', [U('请叫我大王'), A('好的大王')], 'A');
expectOk('A3 我想改名叫X', '阿川', '我想改名叫阿川', [U('我想改名叫阿川')], 'A');
// ── 层级 A：放开的口语说法（生产原话）──
expectOk('A4 你可以叫我X', '小川', '你可以叫我小川', [U('你可以叫我小川')], 'A');
expectOk('A5 别叫我A了叫我B', '小川', '别叫我主人了，叫我小川', [U('别叫我主人了，叫我小川')], 'A');
expectOk('A6 给我换个称呼叫X', '小川', '给我换个称呼叫小川', [U('给我换个称呼叫小川')], 'A');
expectOk('A7 把我名字改成X', '小川', '把我名字改成小川', [U('把我名字改成小川')], 'A');
expectOk('A8 我的名字叫X', '小川', '我的名字叫小川', [U('我的名字叫小川')], 'A');
expectOk('A9 以后你叫我X好不好', '小川', '以后你叫我小川好不好', [U('以后你叫我小川好不好')], 'A');
expectOk('A10 不要喊我A叫我B', '小川', '不要喊我主人叫我小川', [U('不要喊我主人叫我小川')], 'A');
// ── 层级 B：裸句式整句（生产原话「叫我川哥」）──
expectOk('B1 叫我X', '川哥', '叫我川哥', [U('叫我川哥')], 'B', '小明');
expectOk('B2 我叫X', '小川', '我叫小川', [U('我叫小川')], 'B');
expectOk('B3 我不叫A我叫B', '小川', '我叫小川', [U('我不叫指挥官，我叫小川')], 'B');
expectOk('B4 记住我叫X', '小川', '记住我叫小川', [U('记住我叫小川')], 'B');
expectOk('B5 你叫我X', '小川', '你叫我小川', [U('你叫我小川')], 'B');
expectOk('B6 叫我X就行', '小川', '叫我小川就行', [U('叫我小川就行')], 'B');
expectOk('B7 LLM 只抄半句也按整句判', '小川', '小川', [U('你就叫我小川吧')], 'B');
// ── 层级 C：ASR 切句（生产 0010 出现过单独一条「叫我」）──
expectOk('C1 以后叫我 + 名字 两条消息', '小川', '以后叫我', [U('以后叫我'), A('嗯？'), U('小川')], 'C');
expectOk('C2 LLM 给不出跨消息证据也过', '小川', '', [U('以后叫我'), U('小川')], 'C');

// ── 负锚 ──
expectReject('N1 哎子贤 呼喊第三人（8-26 实案）', '子贤', '哎子贤', [U('哎子贤')], 'no_intent');
expectReject('N2 我叫X来吃饭 尾巴不是名字', '小明', '我叫小明来吃饭', [U('我叫小明来吃饭')], 'no_intent');
expectReject('N3 他叫我X 转述', '笨蛋', '他叫我笨蛋', [U('他叫我笨蛋')], 'no_intent');
expectReject('N4 妈妈叫我X 转述', '宝宝', '妈妈叫我宝宝', [U('妈妈叫我宝宝')], 'no_intent');
expectReject('N5 大家都叫我X 转述', '小胖', '大家都叫我小胖', [U('大家都叫我小胖')], 'no_intent');
expectReject('N6 叫我起床 动作词黑名单', '起床', '叫我起床', [U('明天早上叫我起床')], 'invalid_name');
expectReject('N7 家庭角色词黑名单（一台一称呼槽）', '妈妈', '以后叫我妈妈', [U('以后叫我妈妈')], 'invalid_name');
expectReject('N8 小可 AI 名黑名单', '小可', '你叫我小可', [U('你叫我小可')], 'invalid_name');
expectReject('N9 代词黑名单', '你', '以后叫我你', [U('以后叫我你')], 'invalid_name');
expectReject('N10 与现名相同', '川哥', '以后叫我川哥', [U('以后叫我川哥')], 'same_as_current');
expectReject('N11 证据编造', '小明', '以后叫我小明', [U('今天天气不错')], 'evidence_not_in_user_text');
expectReject('N12 小可的话不算', '小明', '以后叫我小明', [A('以后叫我小明'), U('好')], 'evidence_not_in_user_text');
expectReject('N13 值证不符（A 句证据填 B 值）', '小红', '以后叫我小明', [U('以后叫我小明')], 'no_intent');
expectReject('N14 只说换称呼没给名字', '主人', '给我换个称呼吧不要喊我主人了', [U('给我换个称呼吧不要喊我主人了')], 'no_intent');
expectReject('N15 名字在触发词前面（倒装）', '小川', '小川叫我起床', [U('小川叫我起床')], 'no_intent');
expectReject('N16 缺 value', '', '以后叫我小明', [U('以后叫我小明')], 'no_value');
expectReject('N17 切句：前句是转述不拼接', '川哥', '', [U('他叫我'), U('川哥')], 'evidence_not_in_user_text', '小明');

// ── isValidNickname 黑名单 ──
for (const [n, want] of [['起床', false], ['妈妈', false], ['宝宝', true], ['小哪吒', true], ['你', false], ['小可', false], ['指挥官', true]] as const) {
  if (isValidNickname(n) === want) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL isValidNickname(${n}) want=${want}`);
  }
}

console.log(`\nrename-gate tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
