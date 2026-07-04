// 浏览器端 cookie_id 生成 + localStorage 持久化。
// 用 crypto.randomUUID（所有现代浏览器支持），fallback 到 Math.random 拼接。

const STORAGE_KEY = 'cc-chat-cookie-id'

export function getOrCreateCookieId(): string {
  if (typeof window === 'undefined') return ''
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)
    if (existing && existing.length >= 16) return existing
    const fresh =
      typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
    window.localStorage.setItem(STORAGE_KEY, fresh)
    return fresh
  } catch {
    // localStorage 不可用（隐私模式 / 老浏览器）→ 用 sessionStorage 兜底
    try {
      const fresh = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
      window.sessionStorage.setItem(STORAGE_KEY, fresh)
      return fresh
    } catch {
      // 都不行 → 返回临时 UUID（关页就丢，限额相当于 disabled）
      return `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
  }
}
