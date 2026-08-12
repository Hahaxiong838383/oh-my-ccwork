const DEFAULT_BASE_URL = 'https://open.feishu.cn'

function uniqueAcl(entries) {
  const output = new Map()
  for (const entry of entries) {
    if (!entry?.subjectType || !entry?.subjectKey) continue
    output.set(`${entry.subjectType}:${entry.subjectKey}`, entry)
  }
  return [...output.values()]
}

function memberTypeOf(member) {
  return String(member?.member_type || member?.type || '').trim().toLowerCase()
}

function memberIdOf(member) {
  return String(member?.member_id || member?.open_id || member?.department_id || member?.chat_id || '').trim()
}

const UNSUPPORTED_MEMBER_TYPES = new Set(['email', 'unionid', 'userid'])

export function mapFeishuAclMember(member, source = 'feishu_acl') {
  const memberType = memberTypeOf(member)
  const memberId = memberIdOf(member)
  if (!memberId) return { entry: null, status: 'unknown', rawType: memberType || 'missing' }
  if (['openid', 'user'].includes(memberType)) return { entry: { subjectType: 'person', subjectKey: `feishu:${memberId}`, source }, status: 'mapped', rawType: memberType }
  if (['opendepartmentid', 'department'].includes(memberType)) return { entry: { subjectType: 'department', subjectKey: memberId, source }, status: 'mapped', rawType: memberType }
  if (['openchat', 'chat', 'group', 'groupid'].includes(memberType)) return { entry: { subjectType: 'chat', subjectKey: memberId, source }, status: 'mapped', rawType: memberType }
  if (memberType === 'wikispaceid') return { entry: { subjectType: 'wiki_space', subjectKey: memberId, source }, status: 'mapped', rawType: memberType }
  if (UNSUPPORTED_MEMBER_TYPES.has(memberType)) return { entry: null, status: 'unsupported', rawType: memberType }
  return { entry: null, status: 'unknown', rawType: memberType || 'missing' }
}

function mapAclMembers(members, source) {
  const mapped = members.map((member) => mapFeishuAclMember(member, source))
  const unknownTypes = [...new Set(mapped.filter((item) => item.status === 'unknown').map((item) => item.rawType))]
  if (unknownTypes.length > 0) {
    throw Object.assign(new Error('Feishu ACL contains unknown member types'), {
      code: 'feishu_acl_member_type_unknown',
      unknownTypeCount: unknownTypes.length,
    })
  }
  return uniqueAcl(mapped.map((item) => item.entry).filter(Boolean))
}

function columnName(number) {
  let value = number
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

export function createFeishuKnowledgeClient({
  appId,
  appSecret,
  tenantHost,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 15_000,
  now = () => Date.now(),
} = {}) {
  let cachedToken = { value: '', expiresAt: 0 }
  const base = new URL(baseUrl)

  async function token() {
    if (cachedToken.value && now() < cachedToken.expiresAt) return cachedToken.value
    const response = await fetchImpl(new URL('/open-apis/auth/v3/tenant_access_token/internal', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || Number(body.code) !== 0 || !body.tenant_access_token) {
      throw Object.assign(new Error(`Feishu token failed: code=${Number(body.code || response.status)}`), { code: 'feishu_token_failed' })
    }
    cachedToken = {
      value: String(body.tenant_access_token),
      expiresAt: now() + Math.max(60, Number(body.expire || 7200) - 300) * 1000,
    }
    return cachedToken.value
  }

  async function request(pathname, { binary = false } = {}) {
    const accessToken = await token()
    const response = await fetchImpl(new URL(pathname, base), {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (binary) {
      if (!response.ok) throw Object.assign(new Error(`Feishu binary request failed: status=${response.status}`), { statusCode: response.status })
      return Buffer.from(await response.arrayBuffer())
    }
    const body = await response.json().catch(() => ({}))
    if (!response.ok || Number(body.code) !== 0) {
      throw Object.assign(new Error(`Feishu request failed: code=${Number(body.code || response.status)}`), {
        code: Number(body.code || response.status),
        statusCode: response.status,
      })
    }
    return body.data || {}
  }

  async function paginate(pathname, itemKey = 'items') {
    const items = []
    let pageToken = ''
    do {
      const separator = pathname.includes('?') ? '&' : '?'
      const data = await request(`${pathname}${separator}page_size=50${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`)
      items.push(...(Array.isArray(data[itemKey]) ? data[itemKey] : []))
      pageToken = data.has_more && data.page_token ? String(data.page_token) : ''
    } while (pageToken)
    return items
  }

  async function listSpaces() {
    return paginate('/open-apis/wiki/v2/spaces')
  }

  async function listSpaceMembers(spaceId) {
    const members = await paginate(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/members`, 'members')
    return mapAclMembers(members, 'feishu_space_member')
  }

  async function listNodes(spaceId) {
    const output = []
    const queue = ['']
    while (queue.length) {
      const parent = queue.shift()
      const pathname = `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes${parent ? `?parent_node_token=${encodeURIComponent(parent)}` : ''}`
      const nodes = await paginate(pathname)
      for (const node of nodes) {
        output.push(node)
        if (node?.has_child && node?.node_token) queue.push(String(node.node_token))
      }
    }
    return output
  }

  async function listPermissionMembers(resourceToken, resourceType) {
    const params = new URLSearchParams({ type: resourceType, fields: 'type' })
    const data = await request(`/open-apis/drive/v1/permissions/${encodeURIComponent(resourceToken)}/members?${params}`)
    return mapAclMembers(Array.isArray(data.items) ? data.items : [], 'feishu_document_acl')
  }

  async function fetchDocx(tokenValue) {
    const data = await request(`/open-apis/docx/v1/documents/${encodeURIComponent(tokenValue)}/raw_content`)
    return { content: String(data.content || '') }
  }

  async function fetchSheet(tokenValue, { maxRows = 200, maxColumns = 26 } = {}) {
    const [metadata, sheetData] = await Promise.all([
      request(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(tokenValue)}?user_id_type=open_id`),
      request(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(tokenValue)}/sheets/query`),
    ])
    const sections = []
    for (const sheet of (Array.isArray(sheetData.sheets) ? sheetData.sheets : []).filter((item) => !item.hidden && item.resource_type === 'sheet')) {
      const rowCount = Math.max(1, Math.min(maxRows, Number(sheet.grid_properties?.row_count || maxRows)))
      const columnCount = Math.max(1, Math.min(maxColumns, Number(sheet.grid_properties?.column_count || maxColumns)))
      const range = `${sheet.sheet_id}!A1:${columnName(columnCount)}${rowCount}`
      const values = await request(`/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(tokenValue)}/values/${encodeURIComponent(range)}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString&user_id_type=open_id`)
      const rows = values.valueRange?.values || []
      sections.push(`# ${String(sheet.title || '工作表')}\n${rows.map((row) => row.map((cell) => String(cell ?? '')).join('\t')).join('\n')}`)
    }
    return {
      title: String(metadata.spreadsheet?.title || ''),
      sourceUrl: String(metadata.spreadsheet?.url || ''),
      ownerId: String(metadata.spreadsheet?.owner_id || ''),
      content: sections.join('\n\n'),
    }
  }

  async function fetchMinute(tokenValue) {
    const metadata = await request(`/open-apis/minutes/v1/minutes/${encodeURIComponent(tokenValue)}?user_id_type=open_id`)
    const transcript = await request(`/open-apis/minutes/v1/minutes/${encodeURIComponent(tokenValue)}/transcript?need_speaker=true&need_timestamp=true&file_format=txt`, { binary: true })
    return {
      title: String(metadata.minute?.title || ''),
      sourceUrl: String(metadata.minute?.url || ''),
      ownerId: String(metadata.minute?.owner_id || ''),
      content: transcript.toString('utf8'),
    }
  }

  function sourceUrl({ nodeToken, resourceType, resourceToken }) {
    if (nodeToken) return `https://${tenantHost}/wiki/${nodeToken}`
    if (resourceType === 'docx') return `https://${tenantHost}/docx/${resourceToken}`
    if (resourceType === 'sheet') return `https://${tenantHost}/sheets/${resourceToken}`
    if (resourceType === 'minutes') return `https://${tenantHost}/minutes/${resourceToken}`
    return ''
  }

  return {
    listSpaces,
    listSpaceMembers,
    listNodes,
    listPermissionMembers,
    fetchDocx,
    fetchSheet,
    fetchMinute,
    sourceUrl,
  }
}
