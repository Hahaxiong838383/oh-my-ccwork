import test from 'node:test'
import assert from 'node:assert/strict'

import { chunkText, createKnowledgeSync } from '../src/sync.mjs'

function config() {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    feishu: { discoverPublicTeamSpaces: true, spaceIds: [], resources: [] },
    sync: { maxResources: 10, chunkChars: 20, chunkOverlap: 4, maxSheetRows: 20, maxSheetColumns: 10 },
  }
}

test('公开团队空间生成 tenant ACL 与权限化知识块', async () => {
  const written = []
  const store = {
    startRun: async () => 'run-1',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => {
      written.push(input)
      return { chunks: input.chunks.length, aclEntries: input.aclEntries.length }
    },
  }
  const client = {
    listSpaces: async () => [{ space_id: 'space-1', name: '公司知识', space_type: 'team', visibility: 'public' }],
    listSpaceMembers: async () => [],
    listNodes: async () => [{ node_token: 'wiki-1', obj_token: 'docx-1', obj_type: 'docx', title: '制度', has_child: false }],
    listPermissionMembers: async () => [],
    fetchDocx: async () => ({ content: '公司制度内容需要按员工权限读取。公司制度内容需要按员工权限读取。' }),
    sourceUrl: () => 'https://example.feishu.cn/wiki/wiki-1',
  }
  const result = await createKnowledgeSync({ config: config(), client, store }).run()
  assert.equal(result.stats.indexed, 1)
  assert.equal(written[0].resource.aclStatus, 'known')
  assert.equal(written[0].aclEntries[0].subjectType, 'tenant')
  assert.ok(written[0].chunks.length >= 2)
})

test('私有资源 ACL 不可用时 fail-closed 且不写正文', async () => {
  const written = []
  const cfg = config()
  cfg.feishu.discoverPublicTeamSpaces = false
  cfg.feishu.resources = [{ type: 'docx', token: 'docx-private', title: '私密文档' }]
  const store = {
    startRun: async () => 'run-2',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => { written.push(input); return { chunks: 0, aclEntries: 0 } },
  }
  const client = {
    listSpaces: async () => [],
    listPermissionMembers: async () => { throw Object.assign(new Error('denied'), { code: 1063002 }) },
    fetchDocx: async () => { throw new Error('must not fetch content') },
    sourceUrl: () => 'https://example.feishu.cn/docx/docx-private',
  }
  const result = await createKnowledgeSync({ config: cfg, client, store }).run()
  assert.equal(result.stats.skipped, 1)
  assert.deepEqual(result.stats.skipReasons, { acl_unknown: 1 })
  assert.equal(written[0].resource.status, 'skipped')
  assert.equal(written[0].resource.aclStatus, 'unknown')
  assert.deepEqual(written[0].chunks, [])
})

test('分块保留重叠且不产生空块', () => {
  const chunks = chunkText('第一段内容。\n\n第二段内容很长很长。\n\n第三段内容。', { maxChars: 16, overlap: 3 })
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((chunk) => chunk.content.length > 0))
})

test('显式文档的 wiki_space ACL 会展开为公开租户 ACL', async () => {
  const written = []
  const cfg = config()
  cfg.feishu.discoverPublicTeamSpaces = false
  cfg.feishu.resources = [{ type: 'docx', token: 'docx-wiki', title: '知识库文档' }]
  const store = {
    startRun: async () => 'run-3',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => { written.push(input); return { chunks: input.chunks.length, aclEntries: input.aclEntries.length } },
  }
  const client = {
    listSpaces: async () => [{ space_id: 'space-public', space_type: 'team', visibility: 'public' }],
    listPermissionMembers: async () => [{ subjectType: 'wiki_space', subjectKey: 'space-public', source: 'feishu_document_acl' }],
    fetchDocx: async () => ({ content: '可供公司员工读取的知识内容。' }),
    sourceUrl: () => 'https://example.feishu.cn/docx/docx-wiki',
  }
  const result = await createKnowledgeSync({ config: cfg, client, store }).run()
  assert.equal(result.stats.indexed, 1)
  assert.deepEqual(written.at(-1).aclEntries, [{ subjectType: 'tenant', subjectKey: cfg.tenantId, source: 'feishu_public_team_space' }])
})
