import { jwtVerify } from 'jose';
/** Pure JWT core. Dependency errors intentionally escape so callers can return 503. */
export async function verifyDeviceCredential(
  header: string | undefined,
  secret: string,
  acceptsCredential: (subject: string, iatSec: number) => boolean | Promise<boolean> = () => true,
): Promise<{ sn: string } | null> {
  if (!header?.startsWith('Bearer ') || !secret) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(secret), { algorithms: ['HS256'] }));
  } catch { return null; }
  if (payload.kind !== 'p003-device' || typeof payload.sub !== 'string' || !payload.sub) return null;
  if (!await acceptsCredential(payload.sub, typeof payload.iat === 'number' ? payload.iat : 0)) return null;
  return { sn: payload.sub };
}
