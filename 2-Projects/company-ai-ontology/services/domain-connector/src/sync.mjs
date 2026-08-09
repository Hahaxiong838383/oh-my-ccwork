import { normalizeSourceRecord } from './source-client.mjs'

export function createDomainSync({ config, clients, store, logger = () => {} } = {}) {
  const running = new Set()
  async function run(sourceKey, { cursorOverride = null, replay = false } = {}) {
    const source = config.sources[sourceKey]
    const client = clients[sourceKey]
    if (!source?.enabled || !client) return { ok: false, status: 'source_disabled', source: sourceKey }
    if (running.has(sourceKey)) return { ok: false, status: 'already_running', source: sourceKey }
    running.add(sourceKey)
    const cursorBefore = cursorOverride == null ? await store.cursor({ tenantId: config.tenantId, sourceSystem: sourceKey }) : String(cursorOverride)
    const runId = await store.startRun({ tenantId: config.tenantId, sourceSystem: sourceKey, cursorBefore, replay })
    const stats = { pages: 0, received: 0, inserted: 0, updated: 0, unchanged: 0, isolated: 0 }
    let cursor = cursorBefore
    try {
      for (let pageIndex = 0; pageIndex < config.maxPages; pageIndex += 1) {
        const page = await client.page({ cursor, limit: config.pageLimit })
        stats.pages += 1
        stats.received += page.items.length
        for (const input of page.items) {
          try {
            const result = await store.upsert({ tenantId: config.tenantId, record: normalizeSourceRecord(input, source) })
            if (result.unchanged) stats.unchanged += 1
            else if (result.inserted) stats.inserted += 1
            else stats.updated += 1
          } catch (error) {
            stats.isolated += 1
            await store.deadLetter({ tenantId: config.tenantId, runId, sourceSystem: sourceKey, sourceReference: String(input?.externalId || '').slice(0, 240), errorCode: String(error?.code || 'record_rejected') })
          }
        }
        cursor = page.nextCursor || cursor
        if (!page.hasMore) break
        if (pageIndex === config.maxPages - 1) throw Object.assign(new Error('source pagination limit exceeded'), { code: 'pagination_limit' })
      }
      await store.finishRun({ tenantId: config.tenantId, runId, sourceSystem: sourceKey, status: 'completed', cursorAfter: cursor, stats })
      return { ok: true, status: 'completed', source: sourceKey, runId, cursorBefore, cursorAfter: cursor, stats }
    } catch (error) {
      logger('domain sync failed', sourceKey, String(error?.code || error?.message || error).slice(0, 160))
      await store.finishRun({ tenantId: config.tenantId, runId, sourceSystem: sourceKey, status: 'failed', cursorAfter: cursor, stats, errorCode: String(error?.code || 'sync_failed') })
      return { ok: false, status: 'failed', source: sourceKey, runId, errorCode: String(error?.code || 'sync_failed'), stats }
    } finally { running.delete(sourceKey) }
  }
  return { run, isRunning: (sourceKey) => sourceKey ? running.has(sourceKey) : running.size > 0 }
}
