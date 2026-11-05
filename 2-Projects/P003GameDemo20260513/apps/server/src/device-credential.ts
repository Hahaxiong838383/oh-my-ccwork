import { jwtVerify } from 'jose';
import type { DeviceCredentialBindingState } from './device-registry-store.js';

export type DeviceCredentialState = {
  binding: DeviceCredentialBindingState | null;
  revokedThroughSec: number | null;
};
export type DeviceCredentialStateReader = (sn: string) => DeviceCredentialState | Promise<DeviceCredentialState>;

/** Pure policy predicate also used by existing routes with direct JWT verification. */
export function isDeviceCredentialBindingAllowed(state: DeviceCredentialBindingState | null, bindingVersion: unknown): boolean {
  // Legacy tokens without a generation remain compatible; newly paired tokens carry it.
  if (bindingVersion !== undefined && (!state || state.status !== 'active' || !state.parent_account_id
    || !Number.isSafeInteger(bindingVersion) || bindingVersion !== state.binding_version)) return false;
  if (!state || state.binding_policy === 'legacy') return true;
  if (state.binding_policy !== 'ble-key-v1') return false;
  return state.status === 'active' && Boolean(state.parent_account_id)
    && Number.isSafeInteger(state.binding_version) && state.binding_version > 0
    && Number.isSafeInteger(bindingVersion) && bindingVersion === state.binding_version;
}

async function readRegistryCredentialState(sn: string): Promise<DeviceCredentialState> {
  // Analytics has its own read-only dependency reader; importing this module must not open a writer there.
  const { deviceRegistryStore } = await import('./device-registry-store.js');
  return { binding: deviceRegistryStore.credentialBindingState(sn), revokedThroughSec: deviceRegistryStore.credentialNotBeforeSec(sn) };
}
/** Shared JWT/policy gate, including direct ARK callers. Lookup failures escape, never fail open. */
export async function verifyDeviceCredential(
  header: string | undefined,
  secret: string,
  acceptsCredential: (subject: string, iatSec: number, bindingVersion?: number) => boolean | Promise<boolean> = () => true,
  readState: DeviceCredentialStateReader = readRegistryCredentialState,
): Promise<{ sn: string; bindingVersion?: number; pairingSessionId?: string } | null> {
  if (!header?.startsWith('Bearer ') || !secret) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(secret), { algorithms: ['HS256'] }));
  } catch { return null; }
  if (payload.kind !== 'p003-device' || typeof payload.sub !== 'string' || !payload.sub) return null;
  const first = await readState(payload.sub);
  const state = first.binding;
  if (!isDeviceCredentialBindingAllowed(state, payload.binding_version)) return null;
  const bindingVersion = typeof payload.binding_version === 'number' ? payload.binding_version : undefined;
  if (bindingVersion !== undefined && (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.iat! <= 0 || payload.exp! <= payload.iat! || payload.iat! > Math.floor(Date.now() / 1000))) return null;
  const iat = typeof payload.iat === 'number' ? payload.iat : 0;
  const revokedThrough = first.revokedThroughSec;
  if (revokedThrough !== null && iat <= revokedThrough) return null;
  if (!await acceptsCredential(payload.sub, iat, bindingVersion)) return null;
  // Re-read after an async caller check so ownership changes during it cannot escape the version gate.
  const latest = await readState(payload.sub);
  if (!isDeviceCredentialBindingAllowed(latest.binding, payload.binding_version)) return null;
  const latestRevocation = latest.revokedThroughSec;
  if (latestRevocation !== null && iat <= latestRevocation) return null;
  return { sn: payload.sub, ...(bindingVersion === undefined ? {} : { bindingVersion }),
    ...(bindingVersion !== undefined && typeof payload.pairing_session_id === 'string' ? { pairingSessionId: payload.pairing_session_id } : {}) };
}
