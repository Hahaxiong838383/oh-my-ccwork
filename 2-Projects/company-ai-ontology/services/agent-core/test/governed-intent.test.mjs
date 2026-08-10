import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyGovernedIntent } from '../src/governed-intent.mjs'

test('受治理意图识别智慧中枢简称与个人飞书操作', () => {
  assert.equal(classifyGovernedIntent({ message: '智慧中枢现在运行状态怎么样？' })?.kind, 'system_status')
  assert.equal(classifyGovernedIntent({ message: '智慧中枢基于 ERP 和市场信号如何形成经营决策？' })?.kind, 'operating_model_explanation')
  assert.equal(classifyGovernedIntent({ message: '请帮我创建一个个人日程。' })?.kind, 'personal_identity_handoff')
})

test('普通公司资料查询不被误判为治理旁路', () => {
  assert.equal(classifyGovernedIntent({ message: '请查询产品知识库里的护眼方案。' }), null)
  assert.equal(classifyGovernedIntent({ message: '分析本月市场趋势和风险。' }), null)
})
