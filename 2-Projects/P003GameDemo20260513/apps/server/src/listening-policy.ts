/** Pure validation. No DB, environment, registry or production-route side effects. */
export const LISTENING_CAPABILITY = 'listening_mode_v1';
export const LISTENING_SN = /^BJP003\d{14}$/;
export interface ListeningSettings { version: number; enabled: boolean; allowlist: string[] }
export function defaultListeningSettings(): ListeningSettings {
  return { version: 1, enabled: false, allowlist: [] };
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
export function parseListeningSettings(value: unknown): ListeningSettings | null {
  if (!record(value) || Object.keys(value).length !== 3
      || !['version', 'enabled', 'allowlist'].every(k => Object.hasOwn(value, k)) || !validVersion(value.version)
      || typeof value.enabled !== 'boolean' || !Array.isArray(value.allowlist)
      || value.allowlist.length > 1000
      || !Array.from(value.allowlist).every(sn => typeof sn === 'string' && LISTENING_SN.test(sn))
      || new Set(value.allowlist).size !== value.allowlist.length) return null;
  return { version: value.version, enabled: value.enabled, allowlist: [...value.allowlist] };
}
/** Pure optimistic-version check; caller must additionally perform atomic DB CAS in one transaction. */
export function updateListeningSettings(current: unknown, expectedVersion: number, next: unknown): ListeningSettings {
  const old = parseListeningSettings(current);
  if (!old || !record(next) || Object.keys(next).length !== 2 || !Object.hasOwn(next, 'enabled')
      || !Object.hasOwn(next, 'allowlist')) throw new Error('invalid_settings');
  if (old.version !== expectedVersion) throw new Error('version_conflict');
  if (old.version === Number.MAX_SAFE_INTEGER) throw new Error('version_exhausted');
  const updated = parseListeningSettings({ version: old.version + 1, ...next });
  if (!updated) throw new Error('invalid_settings');
  return updated;
}
/** device and workerReady must come from authoritative server state, never a request body. */
export function listeningEligible(settings: unknown, device: { sn: string; accountId: string; active: boolean } | null,
  supports: unknown, workerReady: boolean): boolean {
  const parsed = parseListeningSettings(settings);
  return !!parsed?.enabled && device?.active === true && !!device.accountId.trim()
    && parsed.allowlist.includes(device.sn) && workerReady === true
    && Array.isArray(supports) && supports.includes(LISTENING_CAPABILITY);
}
