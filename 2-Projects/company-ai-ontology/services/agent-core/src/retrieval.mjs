export function createPermissionedRetrieval({ store } = {}) {
  if (!store?.permissionedSearch) throw new Error('permissioned retrieval requires store.permissionedSearch')
  return {
    async retrieve({ tenantId, personId, query, limit = 8 }) {
      const evidence = await store.permissionedSearch({ tenantId, personId, query, limit })
      return {
        query: String(query || '').trim(),
        personId,
        evidence,
        evidenceCount: evidence.length,
        permissionFiltered: true,
      }
    },
  }
}
