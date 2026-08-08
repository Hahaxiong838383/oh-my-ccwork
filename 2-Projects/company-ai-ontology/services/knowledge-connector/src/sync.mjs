import { createHash } from 'node:crypto'

function uniqueAcl(entries) {
  const output = new Map()
  for (const entry of entries) output.set(`${entry.subjectType}:${entry.subjectKey}`, entry)
  return [...output.values()]
}

export function chunkText(text, { maxChars = 2800, overlap = 250 } = {}) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!normalized) return []
  const chunks = []
  let offset = 0
  while (offset < normalized.length) {
    let end = Math.min(normalized.length, offset + maxChars)
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n\n', end), normalized.lastIndexOf('\n', end), normalized.lastIndexOf('。', end))
      if (boundary > offset + Math.floor(maxChars * 0.55)) end = boundary + 1
    }
    const content = normalized.slice(offset, end).trim()
    if (content) chunks.push({ index: chunks.length, content, tokenEstimate: Math.ceil(content.length / 2) })
    if (end >= normalized.length) break
    offset = Math.max(offset + 1, end - overlap)
  }
  return chunks
}

function classificationFor(space) {
  return space?.visibility === 'public' ? 'internal' : 'confidential'
}

function selectedSpaces(spaces, config) {
  const explicit = new Set(config.feishu.spaceIds)
  return spaces.filter((space) => explicit.has(String(space.space_id))
    || (config.feishu.discoverPublicTeamSpaces && space.space_type === 'team' && space.visibility === 'public'))
}

function validateExplicitResource(input) {
  const resourceType = String(input?.type || '').trim().toLowerCase()
  const token = String(input?.token || '').trim()
  if (!['docx', 'sheet', 'minutes'].includes(resourceType) || !token) return null
  return {
    resourceType,
    resourceToken: token,
    title: String(input?.title || '').trim(),
    classification: ['public', 'internal', 'confidential', 'restricted'].includes(input?.classification)
      ? input.classification
      : 'confidential',
  }
}

function normalizedAclErrorCode(error) {
  const candidate = String(error?.code ?? error?.statusCode ?? 'acl_unavailable')
  if (/^\d{3,12}$/.test(candidate)) return candidate
  if (/^(acl|feishu)_[a-z0-9_.-]{1,48}$/.test(candidate)) return candidate
  return 'acl_unavailable'
}

export function createKnowledgeSync({ config, client, store, logger = () => {} } = {}) {
  let running = false
  let cachedSpaces = null

  async function contentFor(resource) {
    if (resource.resourceType === 'docx') return client.fetchDocx(resource.resourceToken)
    if (resource.resourceType === 'sheet') return client.fetchSheet(resource.resourceToken, config.sync)
    if (resource.resourceType === 'minutes') return client.fetchMinute(resource.resourceToken)
    return { content: '' }
  }

  async function expandWikiSpaceAcl(entries) {
    const direct = entries.filter((entry) => entry.subjectType !== 'wiki_space')
    const spaceEntries = entries.filter((entry) => entry.subjectType === 'wiki_space')
    if (!spaceEntries.length) return direct
    if (cachedSpaces === null) cachedSpaces = await client.listSpaces()
    for (const entry of spaceEntries) {
      const space = cachedSpaces.find((item) => String(item.space_id) === entry.subjectKey)
      if (space?.space_type === 'team' && space.visibility === 'public') {
        direct.push({ subjectType: 'tenant', subjectKey: config.tenantId, source: 'feishu_public_team_space' })
      } else if (space) {
        direct.push(...await client.listSpaceMembers(entry.subjectKey))
      }
    }
    return uniqueAcl(direct)
  }

  async function skipResource(resource, { reason, aclErrorCode = null } = {}) {
    await store.replaceResource({
      tenantId: config.tenantId,
      resource: {
        ...resource,
        externalKey: `feishu:${resource.resourceType}:${resource.resourceToken}`,
        aclStatus: 'unknown',
        status: 'skipped',
        contentHash: null,
        metadata: {
          ...resource.metadata,
          skipReason: reason,
          ...(aclErrorCode ? { aclErrorCode } : {}),
        },
      },
      aclEntries: [],
      chunks: [],
    })
    return { indexed: false, reason, aclErrorCode }
  }

  async function syncResource(resource) {
    let documentAcl
    try {
      documentAcl = uniqueAcl(await client.listPermissionMembers(resource.resourceToken, resource.resourceType))
    } catch (error) {
      return skipResource(resource, { reason: 'acl_unavailable', aclErrorCode: normalizedAclErrorCode(error) })
    }

    let aclEntries
    try {
      aclEntries = await expandWikiSpaceAcl(documentAcl)
    } catch (error) {
      return skipResource(resource, { reason: 'acl_inheritance_unavailable', aclErrorCode: normalizedAclErrorCode(error) })
    }
    if (!aclEntries.length) return skipResource(resource, { reason: 'acl_empty' })

    const fetched = await contentFor(resource)
    if (fetched.ownerId) aclEntries.push({ subjectType: 'person', subjectKey: `feishu:${fetched.ownerId}`, source: 'feishu_owner' })
    const content = String(fetched.content || '').slice(0, 2_000_000)
    const chunks = chunkText(content, { maxChars: config.sync.chunkChars, overlap: config.sync.chunkOverlap })
    const contentHash = createHash('sha256').update(content).digest('hex')
    const stored = await store.replaceResource({
      tenantId: config.tenantId,
      resource: {
        ...resource,
        externalKey: `feishu:${resource.resourceType}:${resource.resourceToken}`,
        title: fetched.title || resource.title || resource.resourceToken,
        sourceUrl: fetched.sourceUrl || resource.sourceUrl,
        aclStatus: 'known',
        status: chunks.length ? 'active' : 'skipped',
        contentHash,
        metadata: { ...resource.metadata, emptyContent: chunks.length === 0 },
      },
      aclEntries: uniqueAcl(aclEntries),
      chunks,
    })
    return { indexed: chunks.length > 0, chunks: stored.chunks, aclEntries: stored.aclEntries }
  }

  async function run() {
    if (running) return { ok: false, status: 'already_running' }
    running = true
    const runId = await store.startRun({ tenantId: config.tenantId })
    const stats = { spaces: 0, resourcesSeen: 0, indexed: 0, skipped: 0, failed: 0, chunks: 0, skipReasons: {}, aclErrorCodes: {} }
    const recordResult = (result) => {
      if (result.indexed) {
        stats.indexed += 1
        stats.chunks += result.chunks || 0
        return
      }
      stats.skipped += 1
      const reason = String(result.reason || 'not_indexed')
      stats.skipReasons[reason] = (stats.skipReasons[reason] || 0) + 1
      if (result.aclErrorCode) stats.aclErrorCodes[result.aclErrorCode] = (stats.aclErrorCodes[result.aclErrorCode] || 0) + 1
    }
    try {
      cachedSpaces = await client.listSpaces()
      const spaces = selectedSpaces(cachedSpaces, config)
      stats.spaces = spaces.length
      for (const space of spaces) {
        const spaceId = String(space.space_id)
        const nodes = await client.listNodes(spaceId)
        for (const node of nodes) {
          if (stats.resourcesSeen >= config.sync.maxResources) break
          const resourceType = String(node.obj_type || '').toLowerCase()
          if (!['docx', 'sheet'].includes(resourceType) || !node.obj_token) continue
          stats.resourcesSeen += 1
          try {
            const result = await syncResource({
              resourceType,
              resourceToken: String(node.obj_token),
              spaceId,
              parentExternalKey: String(node.parent_node_token || '') || null,
              title: String(node.title || node.obj_token),
              sourceUrl: client.sourceUrl({ nodeToken: node.node_token, resourceType, resourceToken: node.obj_token }),
              classification: classificationFor(space),
              sourceUpdatedAt: node.obj_edit_time ? new Date(Number(node.obj_edit_time) * 1000) : null,
              metadata: { nodeToken: node.node_token, spaceName: space.name, spaceVisibility: space.visibility },
            })
            recordResult(result)
          } catch (error) {
            stats.failed += 1
            logger('knowledge resource sync failed', resourceType, String(error?.code || error?.message || error).slice(0, 160))
          }
        }
      }

      for (const item of config.feishu.resources.map(validateExplicitResource).filter(Boolean)) {
        if (stats.resourcesSeen >= config.sync.maxResources) break
        stats.resourcesSeen += 1
        try {
          const result = await syncResource({
            ...item,
            spaceId: null,
            parentExternalKey: null,
            sourceUrl: client.sourceUrl(item),
            sourceUpdatedAt: null,
            metadata: { explicit: true },
          })
          recordResult(result)
        } catch (error) {
          stats.failed += 1
          logger('explicit knowledge resource sync failed', item.resourceType, String(error?.code || error?.message || error).slice(0, 160))
        }
      }
      await store.finishRun({ tenantId: config.tenantId, runId, status: 'completed', stats })
      await store.audit({ tenantId: config.tenantId, eventType: 'knowledge_sync_completed', resourceId: runId, payload: stats })
      return { ok: true, status: 'completed', runId, stats }
    } catch (error) {
      const errorCode = String(error?.code || 'knowledge_sync_failed')
      await store.finishRun({ tenantId: config.tenantId, runId, status: 'failed', stats, errorCode }).catch(() => {})
      await store.audit({ tenantId: config.tenantId, eventType: 'knowledge_sync_failed', resourceId: runId, payload: { ...stats, errorCode } }).catch(() => {})
      throw error
    } finally {
      running = false
    }
  }

  return { run, isRunning: () => running }
}
