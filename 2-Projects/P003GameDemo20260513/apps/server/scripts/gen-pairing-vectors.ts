/**
 * ECIES 跨语言测试向量生成器（codex 开工 prompt §四-1）。
 * 跑法：npx tsx scripts/gen-pairing-vectors.ts → 覆写 fixtures/pairing-ecies-vectors.json
 * 全部密钥为固定测试值，无生产秘密。Android 侧按向量逐字段对撞自己的实现。
 */
import { createECDH, createHash, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { encryptCredential, decryptCredential, b64url } from '../src/pairing-crypto.js';

// 固定测试密钥（仅测试用途）：确定性生成自固定种子字节
const DEVICE_PRIV = Buffer.from('11'.repeat(32), 'hex'); // 0x1111…（合法 P-256 标量）
const SERVER_EPH_PRIV = Buffer.from('22'.repeat(32), 'hex');
const IV = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex'); // 固定 12B
const SN = 'BJP00326060100000601';
const NONCE = 'dGVzdC1ub25jZS0xMjgtYml0LXZlY3Rvcg'; // 传输形态 base64url 字符串
const JWT_PLAINTEXT = 'eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoicDAwMy1kZXZpY2UiLCJzdWIiOiJURVNULU9OTFkifQ.TEST-ONLY-NOT-A-REAL-CREDENTIAL';

const dev = createECDH('prime256v1');
dev.setPrivateKey(DEVICE_PRIV);
const devicePk = dev.getPublicKey(null, 'compressed') as Buffer;

const eph = createECDH('prime256v1');
eph.setPrivateKey(SERVER_EPH_PRIV);
const shared = eph.computeSecret(devicePk);
const salt = createHash('sha256').update(Buffer.from(NONCE, 'utf8')).digest();
const hkdfOut = Buffer.from(hkdfSync('sha256', shared, salt, 'p003-pairing-v2', 32));

const env = encryptCredential(devicePk, NONCE, SN, JWT_PLAINTEXT, { ephPriv: SERVER_EPH_PRIV, iv: IV });
// 自检：向量必须能被参考解密还原
const back = decryptCredential(DEVICE_PRIV, env, NONCE, SN);
if (back !== JWT_PLAINTEXT) throw new Error('向量自检失败：解密结果与明文不一致');

const both = (buf: Buffer) => ({ hex: buf.toString('hex'), b64url: b64url(buf) });
const vectors = {
  _note: 'ECIES-P256-HKDF-SHA256-A256GCM 跨语言测试向量。全部为固定测试值，无生产秘密。',
  _contract: 'CC_P003_PAIRING_CRYPTO_CONTRACT_20260822 + codex 开工 prompt 2026-08-22',
  alg: 'ECIES-P256-HKDF-SHA256-A256GCM',
  sn_canonical: SN,
  aad_utf8: both(Buffer.from(SN, 'utf8')),
  pairing_nonce_string: NONCE,
  salt_sha256_of_nonce_utf8: both(salt),
  hkdf_info_ascii: 'p003-pairing-v2',
  device_private_key: both(DEVICE_PRIV),
  device_public_key_compressed: both(devicePk),
  server_ephemeral_private_key: both(SERVER_EPH_PRIV),
  server_ephemeral_public_key_compressed: both(Buffer.from(env.server_eph_pk, 'base64url')),
  ecdh_shared_secret: both(shared),
  hkdf_output_aes_key: both(hkdfOut),
  iv: both(IV),
  jwt_plaintext_utf8: JWT_PLAINTEXT,
  ciphertext_with_tag: both(Buffer.from(env.ciphertext, 'base64url')),
  gcm_tag_is_last_16_bytes: true,
  self_check: 'decrypt(ciphertext) === jwt_plaintext 已在生成时验证',
};
writeFileSync(new URL('./fixtures/pairing-ecies-vectors.json', import.meta.url), JSON.stringify(vectors, null, 2) + '\n');
console.log('向量已写出 + 自检通过');
