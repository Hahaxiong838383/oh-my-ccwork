import { createECDH, createHash, hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 配网凭据加密交付（安全合同 CC_P003_PAIRING_CRYPTO_CONTRACT_20260822，codex 开工 prompt 冻结）。
 *
 * alg = ECIES-P256-HKDF-SHA256-A256GCM
 *   shared = ECDH(server_ephemeral_priv, device_pk)          — P-256/prime256v1
 *   salt   = SHA256(pairing_nonce 传输形态字符串的 UTF-8 字节)
 *   key    = HKDF-SHA256(shared, salt, info="p003-pairing-v2", 32)
 *   cipher = AES-256-GCM, IV 12B 随机, tag 16B 拼 ciphertext 尾部
 *   AAD    = 权威规范化 SN（大写）UTF-8 —— 把密文绑死到这台 SN
 * 编码：压缩点 33B（0x02/0x03），base64url 无 padding。
 *
 * 红线：device_priv / shared / HKDF 输出 / 明文 JWT 零进日志；
 *       server_eph_pk / iv / ciphertext 非秘密可记。
 */

export const ECIES_ALG = 'ECIES-P256-HKDF-SHA256-A256GCM';
const HKDF_INFO = 'p003-pairing-v2';

export function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function fromB64url(s: string): Buffer | null {
  // 只接受 canonical base64url 无 padding（合同：非 canonical / padding 一律拒）
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (b64url(buf) !== s) return null;
  return buf;
}

/**
 * 严格验证设备临时公钥（confirm 入口用，fail fast）：
 * 33B 压缩点 + 前缀 0x02/0x03 + 点真实位于 P-256 曲线上（ECDH computeSecret 底层
 * 由 OpenSSL 做点验证，非曲线点/无穷点会 throw——用一次真实 ECDH 试算兜底）。
 */
export function validateDevicePk(pkB64url: string): Buffer | null {
  const pk = fromB64url(pkB64url);
  if (!pk || pk.length !== 33) return null;
  if (pk[0] !== 0x02 && pk[0] !== 0x03) return null;
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pk); // 非法点在此 throw
    return pk;
  } catch {
    return null;
  }
}

export type EciesEnvelope = {
  alg: typeof ECIES_ALG;
  server_eph_pk: string; // base64url 压缩点 33B
  iv: string; // base64url 12B
  ciphertext: string; // base64url (ct || tag16B)
};

function deriveKey(shared: Buffer, nonceString: string): Buffer {
  const salt = createHash('sha256').update(Buffer.from(nonceString, 'utf8')).digest();
  return Buffer.from(hkdfSync('sha256', shared, salt, HKDF_INFO, 32));
}

/** 加密凭据。每次调用生成新 server ephemeral 对与新 IV（幂等重试自然产生不同密文）。 */
export function encryptCredential(
  devicePk: Buffer,
  nonceString: string,
  sn: string,
  credentialJwt: string,
  fixed?: { ephPriv: Buffer; iv: Buffer }, // 仅测试向量生成用；生产不传
): EciesEnvelope {
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.ephPriv);
  else ecdh.generateKeys();
  const shared = ecdh.computeSecret(devicePk);
  const key = deriveKey(shared, nonceString);
  const iv = fixed ? fixed.iv : randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(sn, 'utf8'));
  const ct = Buffer.concat([cipher.update(credentialJwt, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: ECIES_ALG,
    server_eph_pk: b64url(ecdh.getPublicKey(null, 'compressed') as Buffer),
    iv: b64url(iv),
    ciphertext: b64url(Buffer.concat([ct, tag])),
  };
}

/** 设备侧解密的参考实现（测试对撞与向量生成用；生产 server 不调用）。 */
export function decryptCredential(
  devicePriv: Buffer,
  env: EciesEnvelope,
  nonceString: string,
  sn: string,
): string {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(devicePriv);
  const shared = ecdh.computeSecret(fromB64url(env.server_eph_pk)!);
  const key = deriveKey(shared, nonceString);
  const blob = fromB64url(env.ciphertext)!;
  const ct = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, fromB64url(env.iv)!);
  d.setAAD(Buffer.from(sn, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
