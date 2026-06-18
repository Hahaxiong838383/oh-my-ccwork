// P0.2 Prompt Orchestrator 单测：验证「关于这个孩子」user_memory 区块的注入逻辑。
// 跑法：cd apps/server && NODE_OPTIONS=--experimental-sqlite ./node_modules/.bin/tsx scripts/orchestrator.test.ts
import assert from 'node:assert';
import { assembleSystemPrompt } from '../src/prompt-orchestrator.js';
import { profileStore } from '../src/profile-store.js';

const BASE = '你是儿童陪伴机器人小可。';

// case1: 匿名 + 前端 meta → 注入昵称/年龄/性别
{
  const r = assembleSystemPrompt(BASE, { nickname: '小明', age: '7岁', gender: '男孩' }, null);
  assert.ok(r.startsWith(BASE), 'base 前缀保留');
  assert.ok(r.includes('【关于这个孩子'), '含 user_memory 区块');
  assert.ok(r.includes('小明') && r.includes('7岁') && r.includes('男孩'), '含昵称/年龄/性别');
  console.log('✅ case1 匿名+meta：注入孩子信息');
}

// case2: 无任何信息 → basePrompt 原样（不破坏现有行为）
{
  const r = assembleSystemPrompt(BASE, null, null);
  assert.equal(r, BASE, '无信息时原样返回');
  console.log('✅ case2 无信息：basePrompt 原样不变');
}

// case3: 部分信息（只 nickname）→ 只注入有的字段
{
  const r = assembleSystemPrompt(BASE, { nickname: '豆豆' }, null);
  assert.ok(r.includes('豆豆'), '含昵称');
  assert.ok(!r.includes('年龄：'), '无年龄字段不出现');
  console.log('✅ case3 部分信息：只注入存在的字段');
}

// case4: 登录用户 → profile-store 后端权威覆盖前端 meta + birthday→年龄
{
  profileStore.upsertProfile('test-acct-p02', { nickname: '小红', birthday: '2016-03', gender: '女孩' });
  const r = assembleSystemPrompt(BASE, { nickname: '前端名', age: '', gender: '' }, { accountId: 'test-acct-p02', role: 'parent' });
  assert.ok(r.includes('小红'), 'profile nickname 覆盖前端 meta');
  assert.ok(!r.includes('前端名'), '前端名被 profile 覆盖');
  assert.ok(r.includes('岁'), 'birthday 转出年龄');
  profileStore.deleteByAccountId('test-acct-p02'); // 清理测试数据
  console.log('✅ case4 登录：profile-store 权威覆盖前端 meta + birthday→年龄');
}

console.log('\n🎉 P0.2 orchestrator 全部通过');
