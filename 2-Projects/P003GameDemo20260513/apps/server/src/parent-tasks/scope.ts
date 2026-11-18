import { createHash } from 'node:crypto';
import { accountStore } from '../account-store.js';
import { deviceRegistryStore, type DeviceRecord } from '../device-registry-store.js';
import { configuredHistoryScope, assertHistoryScope } from '../history-scope.js';
import { ObservationError } from '../history-observations.js';

export class TaskError extends Error {
  constructor(readonly status: 400|401|403|404|409|503, readonly code: string, readonly reason: string) {
    super(reason);
  }
}
export const missing = () => new TaskError(404, 'not_found', 'resource_not_found');
export const invalid = (reason: string) => new TaskError(400, 'bad_request', reason);

export type TaskScope = {
  key: string; sn: string; publicId: string; owner: string; accountId: string;
  bindingVersion: number; epoch: number; historySinceMs: number;
};

function deviceScope(d: DeviceRecord | null): TaskScope | null {
  if (!d || d.status !== 'active' || !d.parent_account_id || !d.public_id || !d.account_id) return null;
  const identity = deviceRegistryStore.arkIdentity(d.sn);
  if (!identity || identity.account_id !== d.account_id || accountStore.findAccount(d.parent_account_id)?.role !== 'parent'
      || accountStore.findAccount(d.account_id)?.role !== 'device') return null;
  const key = createHash('sha256').update(JSON.stringify([d.sn, d.public_id, d.parent_account_id, d.account_id, d.binding_version, identity.epoch])).digest('hex');
  // An older segment is eligible only for a previously verified exact ownership generation.
  let historySinceMs = Math.max(d.updated_at, (deviceRegistryStore.credentialNotBeforeSec(d.sn) ?? 0) * 1000);
  const history = configuredHistoryScope();
  if (history?.public_id === d.public_id && history.parent_account_id === d.parent_account_id &&
      history.account_id === d.account_id && history.binding_version === d.binding_version && history.epoch === identity.epoch) {
    try { assertHistoryScope(history); historySinceMs = 0; }
    catch (err) { if (!(err instanceof ObservationError && err.status === 404)) throw err; }
  }
  return {key, sn:d.sn, publicId:d.public_id, owner:d.parent_account_id, accountId:d.account_id,
    bindingVersion:d.binding_version, epoch:identity.epoch, historySinceMs};
}
export const taskScopeForDevice = (sn: string) => deviceScope(deviceRegistryStore.get(sn));
export function taskScopeForParent(publicId: string, owner: string, role: string) {
  if (role !== 'parent') throw new TaskError(403,'forbidden','parent_role_required');
  const device = deviceRegistryStore.getByPublicId(publicId);
  if (!device || device.parent_account_id !== owner) throw missing();
  const scope = deviceScope(device);
  if (!scope) throw missing();
  return scope;
}
