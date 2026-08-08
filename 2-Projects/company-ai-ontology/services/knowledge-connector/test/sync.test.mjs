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
    listPermissionMembers: async () => [{ subjectType: 'wiki_space', subjectKey: 'space-1', source: 'feishu_document_acl' }],
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
  assert.deepEqual(result.stats.skipReasons, { acl_unavailable: 1 })
  assert.deepEqual(result.stats.aclErrorCodes, { 1063002: 1 })
  assert.equal(written[0].resource.status, 'skipped')
  assert.equal(written[0].resource.aclStatus, 'unknown')
  assert.equal(written[0].resource.metadata.aclErrorCode, '1063002')
  assert.deepEqual(written[0].chunks, [])
})

test('知识空间文档 ACL 读取失败时即使空间公开也不得读取正文', async () => {
  const written = []
  let contentReads = 0
  let spaceMemberReads = 0
  const store = {
    startRun: async () => 'run-acl-error',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => { written.push(input); return { chunks: input.chunks.length, aclEntries: input.aclEntries.length } },
  }
  const client = {
    listSpaces: async () => [{ space_id: 'space-public', name: '公开知识', space_type: 'team', visibility: 'public' }],
    listSpaceMembers: async () => { spaceMemberReads += 1; return [{ subjectType: 'person', subjectKey: 'feishu:ou_space_user', source: 'feishu_space_member' }] },
    listNodes: async () => [{ node_token: 'wiki-denied', obj_token: 'docx-denied', obj_type: 'docx', title: '权限未知文档', has_child: false }],
    listPermissionMembers: async () => { throw Object.assign(new Error('denied'), { code: 1063004 }) },
    fetchDocx: async () => { contentReads += 1; return { content: '即使正文接口可读，也不应在 ACL 失败后读取。' } },
    sourceUrl: () => 'https://example.feishu.cn/wiki/wiki-denied',
  }
  const result = await createKnowledgeSync({ config: config(), client, store }).run()
  assert.equal(result.stats.indexed, 0)
  assert.equal(result.stats.skipped, 1)
  assert.deepEqual(result.stats.skipReasons, { acl_unavailable: 1 })
  assert.deepEqual(result.stats.aclErrorCodes, { 1063004: 1 })
  assert.equal(contentReads, 0)
  assert.equal(spaceMemberReads, 0)
  assert.deepEqual(written[0].aclEntries, [])
  assert.deepEqual(written[0].chunks, [])
  assert.equal(written[0].resource.metadata.aclErrorCode, '1063004')
})

test('ACL 错误码只保留白名单字符且不记录原始错误正文', async () => {
  const written = []
  const cfg = config()
  cfg.feishu.discoverPublicTeamSpaces = false
  cfg.feishu.resources = [{ type: 'docx', token: 'docx-redacted', title: '错误码脱敏文档' }]
  const store = {
    startRun: async () => 'run-redacted-error',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => { written.push(input); return { chunks: input.chunks.length, aclEntries: input.aclEntries.length } },
  }
  const client = {
    listSpaces: async () => [],
    listPermissionMembers: async () => { throw Object.assign(new Error('contains private upstream detail'), { code: 'UNSAFE_ERROR_PAYLOAD' }) },
    fetchDocx: async () => { throw new Error('must not fetch content') },
    sourceUrl: () => 'https://example.feishu.cn/docx/docx-redacted',
  }
  const result = await createKnowledgeSync({ config: cfg, client, store }).run()
  assert.deepEqual(result.stats.aclErrorCodes, { acl_unavailable: 1 })
  assert.equal(written[0].resource.metadata.aclErrorCode, 'acl_unavailable')
  assert.equal(JSON.stringify(written[0]).includes('private upstream detail'), false)
  assert.equal(JSON.stringify(written[0]).includes('UNSAFE_ERROR_PAYLOAD'), false)
})

test('文档声明空间继承但空间成员 ACL 不可用时不得读取正文', async () => {
  const written = []
  let contentReads = 0
  const store = {
    startRun: async () => 'run-space-acl-error',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => { written.push(input); return { chunks: input.chunks.length, aclEntries: input.aclEntries.length } },
  }
  const client = {
    listSpaces: async () => [{ space_id: 'space-private', name: '私有知识', space_type: 'team', visibility: 'private' }],
    listSpaceMembers: async () => { throw Object.assign(new Error('denied'), { code: 1063004 }) },
    listNodes: async () => [{ node_token: 'wiki-space-denied', obj_token: 'docx-space-denied', obj_type: 'docx', title: '空间权限未知文档', has_child: false }],
    listPermissionMembers: async () => [{ subjectType: 'wiki_space', subjectKey: 'space-private', source: 'feishu_document_acl' }],
    fetchDocx: async () => { contentReads += 1; return { content: '空间成员未知时不应读取。' } },
    sourceUrl: () => 'https://example.feishu.cn/wiki/wiki-space-denied',
  }
  const cfg = config()
  cfg.feishu.discoverPublicTeamSpaces = false
  cfg.feishu.spaceIds = ['space-private']
  const result = await createKnowledgeSync({ config: cfg, client, store }).run()
  assert.equal(result.stats.indexed, 0)
  assert.equal(result.stats.skipped, 1)
  assert.deepEqual(result.stats.skipReasons, { acl_inheritance_unavailable: 1 })
  assert.deepEqual(result.stats.aclErrorCodes, { 1063004: 1 })
  assert.equal(contentReads, 0)
  assert.deepEqual(written[0].aclEntries, [])
  assert.deepEqual(written[0].chunks, [])
})

test('公开空间中的空文档 ACL 不得推断为 tenant 可读', async () => {
  const written = []
  let contentReads = 0
  let spaceMemberReads = 0
  const store = {
    startRun: async () => 'run-empty-acl',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => { written.push(input); return { chunks: input.chunks.length, aclEntries: input.aclEntries.length } },
  }
  const client = {
    listSpaces: async () => [{ space_id: 'space-public', name: '公开知识', space_type: 'team', visibility: 'public' }],
    listSpaceMembers: async () => { spaceMemberReads += 1; return [] },
    listNodes: async () => [{ node_token: 'wiki-empty', obj_token: 'docx-empty', obj_type: 'docx', title: '无 ACL 文档', has_child: false }],
    listPermissionMembers: async () => [],
    fetchDocx: async () => { contentReads += 1; return { content: '不能推断全员可读。' } },
    sourceUrl: () => 'https://example.feishu.cn/wiki/wiki-empty',
  }
  const result = await createKnowledgeSync({ config: config(), client, store }).run()
  assert.equal(result.stats.indexed, 0)
  assert.equal(result.stats.skipped, 1)
  assert.deepEqual(result.stats.skipReasons, { acl_empty: 1 })
  assert.deepEqual(result.stats.aclErrorCodes, {})
  assert.equal(contentReads, 0)
  assert.equal(spaceMemberReads, 0)
  assert.deepEqual(written[0].aclEntries, [])
  assert.deepEqual(written[0].chunks, [])
})

test('文档 ACL 未声明 wikispaceid 时不得继承知识空间成员', async () => {
  const written = []
  let spaceMemberReads = 0
  const store = {
    startRun: async () => 'run-no-inheritance',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => { written.push(input); return { chunks: input.chunks.length, aclEntries: input.aclEntries.length } },
  }
  const client = {
    listSpaces: async () => [{ space_id: 'space-private', name: '私有知识', space_type: 'team', visibility: 'private' }],
    listSpaceMembers: async () => { spaceMemberReads += 1; return [{ subjectType: 'person', subjectKey: 'feishu:ou_space_user', source: 'feishu_space_member' }] },
    listNodes: async () => [{ node_token: 'wiki-direct', obj_token: 'docx-direct', obj_type: 'docx', title: '直接授权文档', has_child: false }],
    listPermissionMembers: async () => [{ subjectType: 'person', subjectKey: 'feishu:ou_direct_user', source: 'feishu_document_acl' }],
    fetchDocx: async () => ({ content: '只有直接授权用户可以读取。' }),
    sourceUrl: () => 'https://example.feishu.cn/wiki/wiki-direct',
  }
  const cfg = config()
  cfg.feishu.discoverPublicTeamSpaces = false
  cfg.feishu.spaceIds = ['space-private']
  const result = await createKnowledgeSync({ config: cfg, client, store }).run()
  assert.equal(result.stats.indexed, 1)
  assert.equal(spaceMemberReads, 0)
  assert.deepEqual(written[0].aclEntries, [{ subjectType: 'person', subjectKey: 'feishu:ou_direct_user', source: 'feishu_document_acl' }])
})

test('文档 ACL 明确声明 wikispaceid 时才展开私有空间成员', async () => {
  const written = []
  let spaceMemberReads = 0
  const store = {
    startRun: async () => 'run-with-inheritance',
    finishRun: async () => {},
    audit: async () => {},
    replaceResource: async (input) => { written.push(input); return { chunks: input.chunks.length, aclEntries: input.aclEntries.length } },
  }
  const client = {
    listSpaces: async () => [{ space_id: 'space-private', name: '私有知识', space_type: 'team', visibility: 'private' }],
    listSpaceMembers: async () => { spaceMemberReads += 1; return [{ subjectType: 'person', subjectKey: 'feishu:ou_space_user', source: 'feishu_space_member' }] },
    listNodes: async () => [{ node_token: 'wiki-inherited', obj_token: 'docx-inherited', obj_type: 'docx', title: '空间继承文档', has_child: false }],
    listPermissionMembers: async () => [{ subjectType: 'wiki_space', subjectKey: 'space-private', source: 'feishu_document_acl' }],
    fetchDocx: async () => ({ content: '知识空间成员可以读取。' }),
    sourceUrl: () => 'https://example.feishu.cn/wiki/wiki-inherited',
  }
  const cfg = config()
  cfg.feishu.discoverPublicTeamSpaces = false
  cfg.feishu.spaceIds = ['space-private']
  const result = await createKnowledgeSync({ config: cfg, client, store }).run()
  assert.equal(result.stats.indexed, 1)
  assert.equal(spaceMemberReads, 1)
  assert.deepEqual(written[0].aclEntries, [{ subjectType: 'person', subjectKey: 'feishu:ou_space_user', source: 'feishu_space_member' }])
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
