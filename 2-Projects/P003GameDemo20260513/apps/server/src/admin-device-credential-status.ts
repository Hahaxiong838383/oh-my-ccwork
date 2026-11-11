import { DatabaseSync } from 'node:sqlite';

type Device = { sn: string; binding_policy: string; parent_account_id: string | null; binding_version: number };
type Receipt = {
  bound_at_ms: number; claim_expires_at_ms: number; claimed_at_ms: number | null;
  activated_at_ms: number | null; revoked_at_ms: number | null;
};
export type BleCredentialStatus = {
  state: 'available' | 'unavailable';
  // Historical evidence for this owner + binding generation, not a validity decision.
  issued_at_ms: number | null;
  authenticated_at_ms: number | null;
  pairing: {
    state: 'none' | 'waiting_claim' | 'claim_expired' | 'waiting_auth' | 'authenticated' | 'revoked';
    bound_at_ms: number | null;
    claim_deadline_ms: number | null;
    claimed_at_ms: number | null;
    authenticated_at_ms: number | null;
  } | null;
};

const unavailable = (): BleCredentialStatus => ({ state: 'unavailable', issued_at_ms: null, authenticated_at_ms: null, pairing: null });

/** Admin GET only. No store initialization/migration, credential issuance or device-side effects. */
export function readBleCredentialStatuses(
  devices: Device[], now = Date.now(), path = process.env.DEVICES_DB_PATH?.trim() || './data/devices.db',
): Map<string, BleCredentialStatus> {
  const selected = devices.filter(d => d.binding_policy === 'ble-key-v1');
  const result = new Map<string, BleCredentialStatus>();
  if (!selected.length) return result;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only=ON; BEGIN');
    const owner = db.prepare('SELECT parent_account_id,binding_version,binding_policy FROM device_registry WHERE sn=?');
    const history = db.prepare(`SELECT MAX(claimed_at_ms) AS issued_at_ms, MAX(activated_at_ms) AS authenticated_at_ms
      FROM ble_binding_receipt WHERE sn=? AND account_id=? AND binding_version=?`);
    const latest = db.prepare(`SELECT bound_at_ms,claim_expires_at_ms,claimed_at_ms,activated_at_ms,revoked_at_ms
      FROM ble_binding_receipt WHERE sn=? AND account_id=? AND binding_version=?
      ORDER BY (revoked_at_ms IS NULL) DESC,bound_at_ms DESC,rowid DESC LIMIT 1`);
    for (const d of selected) {
      const current = owner.get(d.sn) as Omit<Device, 'sn'> | undefined;
      // A concurrent rebind between list() and this read must not expose the previous owner's history.
      if (!current || current.parent_account_id !== d.parent_account_id || current.binding_version !== d.binding_version || current.binding_policy !== d.binding_policy) {
        result.set(d.sn, unavailable()); continue;
      }
      const args = [d.sn, d.parent_account_id, d.binding_version] as const;
      const h = history.get(...args) as { issued_at_ms: number | null; authenticated_at_ms: number | null };
      const r = latest.get(...args) as Receipt | undefined;
      const state = !r ? 'none' : r.revoked_at_ms !== null ? 'revoked' : r.activated_at_ms !== null ? 'authenticated'
        : r.claimed_at_ms !== null ? 'waiting_auth' : now >= r.claim_expires_at_ms ? 'claim_expired' : 'waiting_claim';
      result.set(d.sn, {
        state: 'available', issued_at_ms: h.issued_at_ms, authenticated_at_ms: h.authenticated_at_ms,
        pairing: { state, bound_at_ms: r?.bound_at_ms ?? null, claim_deadline_ms: r?.claim_expires_at_ms ?? null,
          claimed_at_ms: r?.claimed_at_ms ?? null, authenticated_at_ms: r?.activated_at_ms ?? null },
      });
    }
    db.exec('COMMIT');
  } catch {
    // A missing/locked/older DB must not turn an admin read into an outage or falsely say "never issued".
    for (const d of selected) result.set(d.sn, unavailable());
  } finally { db?.close(); }
  return result;
}
