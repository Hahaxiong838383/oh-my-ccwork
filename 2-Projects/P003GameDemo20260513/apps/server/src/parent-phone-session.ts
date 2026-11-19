import { SignJWT } from 'jose';
import { accountStore } from './account-store.js';

export function parentSessionSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET ?? '';
  if (secret !== secret.trim() || Buffer.byteLength(secret) < 32 || secret === 'dev-secret-change-me') {
    throw new Error('auth_not_configured');
  }
  return secret;
}

/** Each caller must verify the credential for this phone before issuing its parent session. */
export async function issueVerifiedPhoneSession(phone: string, secret: string, requestId: string) {
  const { account, isNew } = accountStore.upsertPhoneAccountWithStatus(phone);
  if (account.role !== 'parent') throw new Error('account_role_mismatch');
  const token = await new SignJWT({ accountId: account.id, role: 'parent' })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer('p003').setAudience('kidshub').setExpirationTime('30d')
    .sign(new TextEncoder().encode(secret));
  return {
    ok: true, token, token_type: 'Bearer', expires_in: 2592000,
    account: { id: account.id, role: 'parent', nickname: account.nickname, phone_masked: phone.slice(0, 3) + '****' + phone.slice(-4) },
    is_new: isNew, request_id: requestId,
  };
}
