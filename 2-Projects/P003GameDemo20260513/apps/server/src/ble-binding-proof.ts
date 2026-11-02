import { createHash, createPublicKey, verify } from 'node:crypto';
import { validateDeviceSn } from './device-sn.js';
import { fromB64url, validateDevicePk } from './pairing-crypto.js';

export const BLE_BINDING_PROTOCOL = 'ble-key-v1' as const;
export const BLE_SIGNATURE_ALGORITHM = 'ECDSA-P256-SHA256-P1363' as const;
export class BleBindingError extends Error {
  constructor(public readonly status: number, public readonly error: string) {
    super(error); this.name = 'BleBindingError';
  }
}
export type BleChallengeInput = {
  binding_protocol: typeof BLE_BINDING_PROTOCOL;
  sn: string;
  device_key_id: string;
  ble_session_id: string;
  ble_transcript_hash: string;
  pairing_nonce: string;
  credential_pk: string;
};
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export function validBleId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
export function parseBleChallengeInput(value: unknown): BleChallengeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BleBindingError(400, 'bad_request');
  const row = value as Record<string, unknown>;
  const expected = ['binding_protocol', 'sn', 'device_key_id', 'ble_session_id', 'ble_transcript_hash', 'pairing_nonce', 'credential_pk'];
  if (Object.keys(row).length !== expected.length || Object.keys(row).some(k => !expected.includes(k)) ||
      row.binding_protocol !== BLE_BINDING_PROTOCOL || !validateDeviceSn(row.sn).ok || !validBleId(row.device_key_id) ||
      typeof row.ble_session_id !== 'string' || !/^[0-9a-f]{32}$/.test(row.ble_session_id) ||
      typeof row.ble_transcript_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.ble_transcript_hash) ||
      typeof row.pairing_nonce !== 'string' || fromB64url(row.pairing_nonce)?.length !== 32 ||
      typeof row.credential_pk !== 'string' || !validateDevicePk(row.credential_pk)) throw new BleBindingError(400, 'bad_request');
  return row as BleChallengeInput;
}

/** Exact 12-line domain-separated bytes, not JSON/JWS. Output is canonical base64url. */
export function buildSigningPayload(accountId: string, value: unknown, challengeId: string, challengeNonce: string, expiresAtMs: number): string {
  const input = parseBleChallengeInput(value);
  if (!validBleId(accountId) || !validBleId(challengeId) || fromB64url(challengeNonce)?.length !== 32 ||
      !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) throw new BleBindingError(400, 'bad_request');
  return Buffer.from([
    'P003-BLE-BIND-V1', 'kidshub-ai.hahaxiong.cc', challengeId, challengeNonce, accountId,
    input.sn, input.device_key_id, input.ble_session_id, input.ble_transcript_hash,
    input.credential_pk, input.pairing_nonce, String(expiresAtMs),
  ].join('\n'), 'ascii').toString('base64url');
}

export function normalizeIdentityPublicKey(pem: string): { pem: string; fingerprint: string } {
  try {
    if (typeof pem !== 'string' || pem.length > 2048 || !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem) || /PRIVATE KEY/.test(pem)) throw new Error();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    const der = key.export({ type: 'spki', format: 'der' });
    return { pem: key.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: createHash('sha256').update(der).digest('hex') };
  } catch { throw new BleBindingError(400, 'invalid_identity_public_key'); }
}

export function verifyDeviceProof(publicKeyPem: string, signingPayloadB64url: string, signatureB64url: string): boolean {
  try {
    const input = fromB64url(signingPayloadB64url);
    const signature = typeof signatureB64url === 'string' ? fromB64url(signatureB64url) : null;
    if (!input || !signature || signature.length !== 64 || input.length > 1400) return false;
    const { pem } = normalizeIdentityPublicKey(publicKeyPem);
    // OpenSSL verifies legal r/s values, accepts valid high/low s, hashes the exact bytes once.
    return verify('sha256', input, { key: pem, dsaEncoding: 'ieee-p1363' }, signature);
  } catch { return false; }
}
