import { arkCeiling, arkService, arkStore } from './service.js';

type UnavailableReason = 'not_enabled' | 'no_snapshot' | 'non_normal' | 'identity_mismatch';
function unavailable(reason: UnavailableReason) {
  return {
    available: false, reason, source_mode: null, snapshot_id: null,
    captured_at_ms: null, received_at_ms: null,
    wallets: { family_coin: null, stardust: null }, inventory: { 'M-CARD-001': null },
  };
}

/** Synchronous current-only projection. No analytics/history fallback and no network await. */
export function dashboardArk(sn: string) {
  if (!arkCeiling().includes(sn)) return unavailable('not_enabled');
  const store = arkStore();
  const settings = store.settings();
  if (!settings.enabled) return unavailable('not_enabled');
  const identity = arkService().identity(sn);
  if (!identity) return unavailable('identity_mismatch');
  const grant = store.grant(identity);
  if (!grant) return unavailable(settings.subjects.includes(sn) ? 'identity_mismatch' : 'not_enabled');
  const current = store.current(identity);
  // Also catches identity/grant changes by another process during these SQLite reads.
  const latest = arkService().identity(sn);
  const latestGrant = latest && store.grant(latest);
  if (!latest || latest.account_id !== identity.account_id || latest.epoch !== identity.epoch
    || latestGrant?.grant_id !== grant.grant_id) return unavailable('identity_mismatch');
  if (!current) return unavailable('no_snapshot');
  const s = current.snapshot;
  if (s.captured_at_ms < grant.not_before_ms) return unavailable('identity_mismatch');
  if (s.source_mode !== 'normal') return unavailable('non_normal');
  return {
    available: true, reason: null, source_mode: s.source_mode, snapshot_id: s.snapshot_id,
    captured_at_ms: s.captured_at_ms, received_at_ms: current.received_at_ms,
    wallets: { family_coin: s.wallets.family_coin, stardust: s.wallets.stardust },
    inventory: { 'M-CARD-001': s.inventory['M-CARD-001'] },
  };
}
