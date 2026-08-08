import test from 'node:test'
import assert from 'node:assert/strict'

import { createFeishuKnowledgeClient } from '../src/feishu-client.mjs'

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
