/** Session-bound eligibility grant. This is NOT sufficient internal HTTP authentication.
 * Routes must separately verify worker JWT + service Bearer and current authoritative
 * session/registry ownership, then re-evaluate the current policy for each short lease.
 */
import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { LISTENING_CAPABILITY, LISTENING_SN } from './listening-policy.js';
export interface ListeningBinding { sn: string; room: string; sessionId: string; traceId: string; accountId: string }
const MAX_GRANT_SECONDS = 1800;
const ISSUER = 'p003-listening';
const AUDIENCE = 'p003-worker-listening';
const TYPE = 'p003-listening+jwt';
const FIELDS = ['sn', 'room', 'sessionId', 'traceId', 'accountId'] as const;
function validBinding(value: ListeningBinding): boolean {
  return !!value && LISTENING_SN.test(value.sn) && new RegExp(`^sn-${value.sn}-\\d{1,20}$`).test(value.room)
    && typeof value.traceId === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value.traceId)
    && typeof value.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)
    && typeof value.accountId === 'string' && value.accountId.trim() === value.accountId
    && value.accountId.length > 0 && value.accountId.length <= 128 && !/[\x00-\x1f\x7f]/.test(value.accountId);
}
function key(secret: string | undefined): Uint8Array {
  if (!secret || secret !== secret.trim()) throw new Error('listening_secret_unavailable');
  const encoded = new TextEncoder().encode(secret);
  if (encoded.byteLength < 32) throw new Error('listening_secret_unavailable');
  return encoded;
}
function validMs(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000; }
function validVersion(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1; }
export async function issueListeningGrant(binding: ListeningBinding, policyVersion: number, secret: string | undefined,
  nowMs: number, authorizedUntilMs: number): Promise<string> {
  const signingKey = key(secret);
  if (!validBinding(binding) || !validVersion(policyVersion) || !validMs(nowMs) || !validMs(authorizedUntilMs))
    throw new Error('invalid_listening_grant');
  const issuedAt = Math.floor(nowMs / 1000);
  const expires = Math.min(Math.floor(authorizedUntilMs / 1000), issuedAt + MAX_GRANT_SECONDS);
  if (expires <= issuedAt) throw new Error('listening_authorization_expired');
  // Only allowlisted fields enter the token; never copy arbitrary metadata into credentials.
  const claims = Object.fromEntries(FIELDS.map(field => [field, binding[field]]));
  return new SignJWT({ ...claims, policyVersion, scope: 'listening:lease', capability: LISTENING_CAPABILITY })
    .setProtectedHeader({ alg: 'HS256', typ: TYPE }).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setSubject(binding.sn).setJti(randomUUID()).setIssuedAt(issuedAt).setNotBefore(issuedAt)
    .setExpirationTime(expires).sign(signingKey);
}
/** binding is resolved from current server state, not trusted from body/query parameters. */
export async function verifyListeningGrant(token: string, binding: ListeningBinding, secret: string | undefined,
  nowMs: number): Promise<{ policyVersion: number; expiresAtMs: number } | null> {
  try {
    if (typeof token !== 'string' || token.length > 4096 || !validBinding(binding) || !validMs(nowMs)) return null;
    const { payload } = await jwtVerify(token, key(secret), { issuer: ISSUER, audience: AUDIENCE,
      algorithms: ['HS256'], typ: TYPE, currentDate: new Date(nowMs), clockTolerance: 0,
      requiredClaims: ['iat', 'nbf', 'exp', 'sub', 'jti', ...FIELDS, 'policyVersion', 'scope', 'capability'] });
    if (payload.sub !== binding.sn || FIELDS.some(field => payload[field] !== binding[field])
        || payload.scope !== 'listening:lease' || payload.capability !== LISTENING_CAPABILITY
        || !validVersion(payload.policyVersion) || typeof payload.jti !== 'string' || !payload.jti
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.nbf !== payload.iat
        || payload.iat! > Math.floor(nowMs / 1000) || payload.exp! <= payload.iat!
        || payload.exp! - payload.iat! > MAX_GRANT_SECONDS) return null;
    return { policyVersion: payload.policyVersion, expiresAtMs: payload.exp! * 1000 };
  } catch { return null; }
}
