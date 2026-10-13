/**
 * R5 抽取时机单测 · 跑法：cd apps/server && NODE_OPTIONS=--experimental-sqlite ../../node_modules/.bin/tsx scripts/extract-scheduler.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmp = mkdtempSync(join(tmpdir(), 'extract-sched-'));
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.CONVERSATION_DB_PATH = join(tmp, 'conversation.db');
const S = await import('../src/extract-scheduler.js');
const { conversationStore } = await import('../src/conversation-store.js');
let pass = 0; let fail = 0;
function eq(name: string, got: unknown, want: unknown): void { const g = JSON.stringify(got), w = JSON.stringify(want); if (g === w) pass += 1; else { fail += 1; console.error(`FAIL ${name} got=${g} want=${w}`); } }

// turn 模式（默认）= 原行为
delete process.env.MEMORY_EXTRACT_MODE;
eq('m-1 默认 mode=turn', S.extractMode(), 'turn');
eq('m-2 设备每轮抽', S.decideForTurn({ trigger: false, role: 'device', userText: '嗯', userTurnsInHistory: 7, pendingCount: 0 }), { run: true, reason: 'turn', windowMessages: 6 });
eq('m-3 web 每 3 轮', [S.decideForTurn({ trigger: false, role: 'parent', userText: 'x', userTurnsInHistory: 2, pendingCount: 0 }).run, S.decideForTurn({ trigger: false, role: 'parent', userText: 'x', userTurnsInHistory: 3, pendingCount: 0 }).run], [false, true]);
// trigger 模式判定
eq('t-1 触发词立刻抽', S.decideForTurn({ trigger: true, role: 'device', userText: '以后叫我小川', userTurnsInHistory: 1, pendingCount: 0 }).reason, 'trigger');
eq('t-2 情绪/约定/时间词也触发', ['我明天要考试有点紧张', '我不喜欢奥特曼了', '你答应过我的', '我妈妈说'].map((t) => S.decideForTurn({ trigger: true, role: 'device', userText: t, userTurnsInHistory: 1, pendingCount: 0 }).reason), ['trigger', 'trigger', 'trigger', 'trigger']);
eq('t-3 普通话攒着', S.decideForTurn({ trigger: true, role: 'device', userText: '我们玩个游戏吧', userTurnsInHistory: 1, pendingCount: 0 }), { run: false, reason: 'skip', windowMessages: 0 });
eq('t-4 攒满 5 轮批抽(窗口 10 条)', S.decideForTurn({ trigger: true, role: 'device', userText: '再来一个', userTurnsInHistory: 5, pendingCount: 4 }), { run: true, reason: 'batch', windowMessages: 10 });
eq('t-5 触发窗口带上攒的轮', S.decideForTurn({ trigger: true, role: 'device', userText: '我不喜欢它了', userTurnsInHistory: 4, pendingCount: 3 }).windowMessages, 8);
// 名单
process.env.MEMORY_EXTRACT_MODE = 'trigger';
process.env.MEMORY_EXTRACT_TRIGGER_SN_ALLOWLIST = 'BJP00326010100000002';
eq('a-1 名单内设备走 trigger', S.triggerModeFor('device-BJP00326010100000002', 'device'), true);
eq('a-2 名单外设备仍每轮', S.triggerModeFor('device-BJP00326060100200003', 'device'), false);
eq('a-3 web 账号永远原行为', S.triggerModeFor('acct-1', 'parent'), false);
process.env.MEMORY_EXTRACT_TRIGGER_SN_ALLOWLIST = '';
eq('a-4 名单空=全部设备', S.triggerModeFor('device-BJP00326060100200003', 'device'), true);
// onTurn 状态机 + idle 补抽（临时库）
S.resetPending();
const ACC = 'device-SCHEDTEST0001';
const T0 = Date.now() - 3600_000; // 一小时前（idle 判定用真实 now 比较）
eq('o-1 第一轮普通话 skip 并攒 1', (S.onTurn(ACC, 'device', '我们玩个游戏', 1, T0).run, S.pendingOf(ACC)?.count), 1);
S.onTurn(ACC, 'device', '再玩一个', 2, T0 + 1000);
eq('o-2 触发词抽并清零', (S.onTurn(ACC, 'device', '我明天要去游泳', 3, T0 + 2000).reason, S.pendingOf(ACC)?.count), 0);
S.onTurn(ACC, 'device', '好玩', 4, T0 + 3000);
S.onTurn(ACC, 'device', '再来', 5, T0 + 4000);
eq('o-3 攒 2 轮', S.pendingOf(ACC)?.count, 2);
// 落两条对话到库（ts 在上次抽取之后），3 分钟没新发言 → flushIdle 补抽（LLM 无 key 会失败但不抛，且清零）
const r1 = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'user', text: '好玩' });
const r2 = conversationStore.add({ account_id: ACC, session_id: 'rtc', role: 'assistant', text: '嘿嘿' });
void r1; void r2;
eq('o-4 未到 3 分钟不补抽', await S.flushIdle(T0 + 5000), 0);
const flushed = await S.flushIdle(Date.now());
eq('o-5 空隙到期补抽 1 个账号并清零', [flushed, S.pendingOf(ACC)?.count], [1, 0]);
console.log(`\nextract-scheduler tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
