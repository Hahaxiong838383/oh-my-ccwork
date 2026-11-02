import { deviceRegistryStore } from './device-registry-store.js';
import { isDeviceCredentialBindingAllowed } from './device-credential.js';
export { isDeviceCredentialBindingAllowed } from './device-credential.js';

/** Includes deleted-device tombstones and unknown policies: neither may use legacy onboarding. */
export function requiresBleProof(sn: string): boolean {
  return deviceRegistryStore.isBleBindingRequired(sn);
}

/** DB errors intentionally propagate; callers must not continue on unavailable policy state. */
export function acceptsDeviceBindingCredential(sn: string, bindingVersion: unknown): boolean {
  return isDeviceCredentialBindingAllowed(deviceRegistryStore.credentialBindingState(sn), bindingVersion);
}
