import test from 'node:test'
import assert from 'node:assert/strict'

import { createFeishuKnowledgeClient, mapFeishuAclMember } from '../src/feishu-client.mjs'

function response(payload, status = 200, contentType = 'application/json') {
  return new Response(contentType === 'application/json' ? JSON.stringify(payload) : payload, {
    status,
    headers: { 'content-type': contentType },
  })
}

test('飞书知识客户端递归列节点并把协作者映射为最小 ACL', async () => {
  const paths = []
  const client = createFeishuKnowledgeClient({
    appId: 'cli_test',
    appSecret: 'x'.repeat(32),
    tenantHost: 'example.feishu.cn',
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      paths.push(parsed.pathname + parsed.search)
      if (parsed.pathname.endsWith('/tenant_access_token/internal')) return response({ code: 0, tenant_access_token: 'token', expire: 7200 })
      if (parsed.pathname.endsWith('/nodes') && !parsed.searchParams.get('parent_node_token')) {
        return response({ code: 0, data: { items: [{ node_token: 'wikcn_parent', obj_token: 'docx_parent', obj_type: 'docx', has_child: true }] } })
      }
      if (parsed.pathname.endsWith('/nodes')) {
        return response({ code: 0, data: { items: [{ node_token: 'wikcn_child', obj_token: 'docx_child', obj_type: 'docx', has_child: false }] } })
      }
      if (parsed.pathname.includes('/permissions/')) {
        return response({ code: 0, data: { items: [
          { member_type: 'openid', member_id: 'ou_user' },
          { member_type: 'opendepartmentid', member_id: 'od_department' },
          { member_type: 'email', member_id: 'private@example.com' },
        ] } })
      }
      throw new Error(`unexpected ${parsed}`)
    },
  })
  const nodes = await client.listNodes('space-1')
  const acl = await client.listPermissionMembers('docx_parent', 'docx')
  assert.equal(nodes.length, 2)
  assert.deepEqual(acl, [
    { subjectType: 'person', subjectKey: 'feishu:ou_user', source: 'feishu_document_acl' },
    { subjectType: 'department', subjectKey: 'od_department', source: 'feishu_document_acl' },
  ])
  assert.equal(paths.filter((path) => path.includes('/nodes')).length, 2)
})

test('飞书成员 type 与 member_type 统一映射为 person department chat Principal', () => {
  assert.deepEqual(mapFeishuAclMember({ type: 'user', member_id: 'ou_user' }, 'space'), {
    entry: { subjectType: 'person', subjectKey: 'feishu:ou_user', source: 'space' }, status: 'mapped', rawType: 'user',
  })
  assert.equal(mapFeishuAclMember({ member_type: 'department', member_id: 'od_department' }).entry.subjectType, 'department')
  assert.equal(mapFeishuAclMember({ member_type: 'openchat', member_id: 'oc_chat' }).entry.subjectType, 'chat')
  assert.equal(mapFeishuAclMember({ type: 'group', member_id: 'oc_group' }).entry.subjectType, 'chat')
  assert.equal(mapFeishuAclMember({ member_type: 'email', member_id: 'private@example.com' }).status, 'unsupported')
  assert.equal(mapFeishuAclMember({ member_type: 'future_type', member_id: 'unknown' }).status, 'unknown')
})

test('飞书 ACL 出现未知成员类型时失败关闭而不是静默吞掉', async () => {
  const client = createFeishuKnowledgeClient({
    appId: 'cli_test', appSecret: 'x'.repeat(32), tenantHost: 'example.feishu.cn',
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/tenant_access_token/internal')) return response({ code: 0, tenant_access_token: 'token', expire: 7200 })
      if (parsed.pathname.includes('/permissions/')) return response({ code: 0, data: { items: [{ member_type: 'future_type', member_id: 'unknown' }] } })
      throw new Error(`unexpected ${parsed}`)
    },
  })
  await assert.rejects(
    client.listPermissionMembers('docx-unknown', 'docx'),
    (error) => error.code === 'feishu_acl_member_type_unknown' && error.unknownTypeCount === 1,
  )
})
