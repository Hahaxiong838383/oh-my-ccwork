/**
 * Phase 2a 设备感知协议层单测：env 开关注入/关闭、白盒层展示、话术铁律文案在场。
 * 跑法：cd apps/server && npx tsx scripts/device-intent-protocol.test.ts
 */
import assert from 'node:assert';

let pass = 0;

// T1 开关关（默认）：不注入
delete process.env.DEVICE_INTENT_OBSERVE;
const { deviceIntentProtocol } = await import('../src/device-brain-prompt.js');
assert.strictEqual(deviceIntentProtocol(), '', 'T1 默认关必须返回空串');
pass++;

// T2 开关开：注入且协议要素齐全
process.env.DEVICE_INTENT_OBSERVE = '1';
const p = deviceIntentProtocol();
assert.ok(p.includes('[[DEV:'), 'T2 协议须含标记格式');
assert.ok(p.includes('暖光=22'), 'T2 协议须含 label 表');
assert.ok(p.includes('绝不要说"我已经调好/正在调整"'), 'T2 话术铁律(不承诺执行)必须在场');
assert.ok(p.includes('不要主动问用户想不想调设备'), 'T2 禁诱导条款必须在场');
assert.ok(p.includes('太亮/刺眼'), 'T2 方向映射必须在场');
pass++;

// T3 开关值非 1：不注入（值校验严格）
process.env.DEVICE_INTENT_OBSERVE = 'true';
assert.strictEqual(deviceIntentProtocol(), '', 'T3 非"1"值不注入');
process.env.DEVICE_INTENT_OBSERVE = '0';
assert.strictEqual(deviceIntentProtocol(), '', 'T3 显式 0 不注入');
pass++;

console.log(`device-intent-protocol: ${pass}/3 全过`);
