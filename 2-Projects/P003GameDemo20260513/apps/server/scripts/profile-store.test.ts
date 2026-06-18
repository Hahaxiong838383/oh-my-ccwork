// P1.1 profile-store 画像 schema 单测：建档默认字段 / updateMemoryFields 部分更新(含改名) /
// interests JSON 解析 / 无档案返 null / migrate（构造时 ALTER 老库，能 SELECT 新列即证明）。
// 跑法：cd apps/server && NODE_OPTIONS=--experimental-sqlite ./node_modules/.bin/tsx scripts/profile-store.test.ts
import assert from 'node:assert';
import { profileStore } from '../src/profile-store.js';

const ACCT = 'test-p1-acct';
profileStore.deleteByAccountId(ACCT); // 清理可能的残留

// 1. 建档：画像字段默认空（能 SELECT 新列 = migrate 生效）
const m = profileStore.upsertProfile(ACCT, { nickname: '小明', birthday: '2018-08', gender: '男孩' });
assert.deepEqual(m.interests, [], '新建档 interests 默认空数组');
assert.equal(m.preferred_address, '', 'preferred_address 默认空');
assert.equal(m.personality_notes, '', 'personality_notes 默认空');
console.log('✅ 1 建档默认画像字段 + migrate 生效（能读新列）');

// 2. updateMemoryFields 部分更新（改名 + 加兴趣），未提供的字段保持
const updated = profileStore.updateMemoryFields(ACCT, {
  nickname: '小白',
  interests: [{ value: '恐龙', confidence: 0.9, last_updated: 1718000000000, source: 'voice' }],
});
assert.ok(updated, '有档案返回非 null');
assert.equal(updated.nickname, '小白', 'nickname 被更新（语音改名）');
assert.equal(updated.gender, '男孩', 'gender 保持（未 patch）');
assert.equal(updated.birthday, '2018-08', 'birthday 保持（未 patch）');
assert.equal(updated.interests.length, 1, 'interests 写入');
console.log('✅ 2 updateMemoryFields 部分更新：改名生效 + 其余字段保持');

// 3. getProfile 重新读：改名持久 + interests JSON 正确解析
const got = profileStore.getProfile(ACCT);
assert.ok(got, '档案存在');
assert.equal(got.nickname, '小白', '改名持久化（重新读还是新名）');
assert.equal(got.interests[0].value, '恐龙', 'interests JSON 解析回数组');
assert.equal(got.interests[0].source, 'voice', 'interests 字段完整');
console.log('✅ 3 getProfile：改名持久 + interests JSON 解析');

// 4. 无档案 updateMemoryFields 返回 null（不凭空建档）
profileStore.deleteByAccountId(ACCT);
assert.equal(profileStore.updateMemoryFields(ACCT, { nickname: 'x' }), null, '无档案返回 null');
console.log('✅ 4 无档案：updateMemoryFields 返回 null（不凭空建档）');

console.log('\n🎉 P1.1 profile-store 画像 schema + updateMemoryFields 全过');
