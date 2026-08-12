import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compileConversationAuthority,
  purposeAllowsResource,
  purposeForTurn,
} from '../src/authority.mjs'

const now = () => new Date('2026-08-11T04:00:00.000Z')

test('用途由请求意图确定且显式用途只能在白名单内收窄', () => {
  assert.equal(purposeForTurn({ intent: 'query', context: {} }), 'company_knowledge_query')
  assert.equal(purposeForTurn({ intent: 'decision', context: {} }), 'decision_support')
  assert.equal(purposeForTurn({ intent: 'task_assist', context: {} }), 'task_execution_support')
  assert.equal(purposeForTurn({ intent: 'task_assist', context: { submission: true } }), 'result_submission')
  assert.equal(purposeForTurn({ intent: 'query', context: { purpose: 'decision_support' } }), 'decision_support')
  assert.equal(purposeForTurn({ intent: 'query', context: { purpose: 'admin_all_access' } }), 'company_knowledge_query')
})

test('私聊只使用实际发送者且不继承任何群聊 Principal', () => {
  const authority = compileConversationAuthority({
    personId: 'feishu:ou_sender',
    context: { conversation: { type: 'private', chatId: 'oc_ignored' }, mentions: ['feishu:ou_other'] },
    purpose: 'company_knowledge_query',
    now,
  })
  assert.equal(authority.snapshot.requestPrincipal, 'user:feishu:ou_sender')
  assert.equal(authority.snapshot.conversationPrincipal, null)
  assert.equal(authority.snapshot.decision, 'allow')
  assert.equal(authority.snapshot.mentionsAffectAuthority, false)
  assert.equal(authority.searchScope.chatKey, '')
})

test('群聊授权只在发送者当前成员证据新鲜时进入检索范围', () => {
  const authority = compileConversationAuthority({
    personId: 'feishu:ou_sender',
    context: {
      conversation: { type: 'chat', chatId: 'oc_current' },
      membership: { status: 'active', observedAt: '2026-08-11T03:59:40.000Z' },
      mentions: ['feishu:ou_more_privileged'],
    },
    purpose: 'decision_support',
    now,
  })
  assert.equal(authority.snapshot.decision, 'allow')
  assert.match(authority.snapshot.conversationPrincipal, /^chat-sha256:[a-f0-9]{64}$/)
  assert.equal(authority.searchScope.chatKey, 'oc_current')
  assert.equal(authority.searchScope.chatMembershipActive, true)
  assert.equal(authority.searchScope.purpose, 'decision_support')
})

test('过期、缺失或已撤销群成员证据失败关闭', () => {
  const stale = compileConversationAuthority({
    personId: 'feishu:ou_sender',
    context: {
      conversation: { type: 'chat', chatId: 'oc_current' },
      membership: { status: 'active', observedAt: '2026-08-11T03:50:00.000Z' },
    },
    purpose: 'company_knowledge_query',
    now,
  })
  const revoked = compileConversationAuthority({
    personId: 'feishu:ou_sender',
    context: {
      conversation: { type: 'chat', chatId: 'oc_current' },
      membership: { status: 'inactive', observedAt: '2026-08-11T03:59:40.000Z' },
    },
    purpose: 'company_knowledge_query',
    now,
  })
  assert.equal(stale.snapshot.decision, 'unknown')
  assert.equal(stale.searchScope.chatKey, '')
  assert.equal(revoked.snapshot.decision, 'deny')
  assert.equal(revoked.searchScope.chatMembershipActive, false)
})

test('资源用途只能收窄现有权限且非法策略失败关闭', () => {
  assert.equal(purposeAllowsResource(undefined, 'decision_support'), true)
  assert.equal(purposeAllowsResource(['company_knowledge_query'], 'decision_support'), false)
  assert.equal(purposeAllowsResource(['decision_support'], 'decision_support'), true)
  assert.equal(purposeAllowsResource(['*'], 'result_submission'), true)
  assert.equal(purposeAllowsResource('decision_support', 'decision_support'), false)
})
