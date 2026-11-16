import { p256 } from '@noble/curves/nist.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from './utf8';

const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

export type BleDirection = 'clientToServer' | 'serverToClient';
export type BleSessionKeys = {
  sessionId: string;
  clientToServerKey: Uint8Array;
  serverToClientKey: Uint8Array;
  clientToServerPrefix: Uint8Array;
  serverToClientPrefix: Uint8Array;
};

function concat(...parts: Uint8Array[]) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  parts.forEach(part => { result.set(part, offset); offset += part.length; });
  return result;
}

function sequenceBytes(sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('BLE sequence 无效');
  const result = new Uint8Array(8);
  const high = Math.floor(sequence / 0x100000000);
  const low = sequence >>> 0;
  result.set([high >>> 24, high >>> 16, high >>> 8, high, low >>> 24, low >>> 16, low >>> 8, low].map(value => value & 255));
  return result;
}

function withBlindingBytes<T>(bytes: Uint8Array | undefined, operation: () => T): T {
  if (!bytes) return operation();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let offset = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues(target: Uint8Array) {
    if (offset + target.length > bytes.length) throw new Error('BLE 安全随机数不足');
    target.set(bytes.subarray(offset, offset + target.length)); offset += target.length;
    return target;
  } } });
  try { return operation(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'crypto', previous);
    else delete (globalThis as { crypto?: Crypto }).crypto;
  }
}

export function createBleKeyPair(secretKey = p256.utils.randomSecretKey(), blindingBytes?: Uint8Array) {
  return { secretKey, publicKey: withBlindingBytes(blindingBytes, () => p256.getPublicKey(secretKey, false)) };
}

export function encodeP256Spki(publicKey: Uint8Array) {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('P-256 公钥格式无效');
  return concat(SPKI_PREFIX, publicKey);
}

export function decodeP256Spki(spki: Uint8Array) {
  if (spki.length !== SPKI_PREFIX.length + 65 || !SPKI_PREFIX.every((value, index) => spki[index] === value)) throw new Error('P-256 SPKI 格式无效');
  return spki.slice(SPKI_PREFIX.length);
}

export function deriveBleSessionKeys(params: {
  sessionId: string;
  clientSecretKey: Uint8Array;
  serverPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  blindingBytes?: Uint8Array;
}): BleSessionKeys {
  if (!/^[0-9a-f]{32}$/.test(params.sessionId) || params.clientNonce.length !== 16 || params.serverNonce.length !== 16) throw new Error('BLE 握手参数无效');
  const shared = withBlindingBytes(params.blindingBytes, () => p256.getSharedSecret(params.clientSecretKey, params.serverPublicKey, true)).slice(1);
  const salt = concat(params.clientNonce, params.serverNonce);
  const info = utf8ToBytes(`P003-BLE-v1|${params.sessionId}`);
  const output = hkdf(sha256, shared, salt, info, 72);
  return {
    sessionId: params.sessionId,
    clientToServerKey: output.slice(0, 32),
    serverToClientKey: output.slice(32, 64),
    clientToServerPrefix: output.slice(64, 68),
    serverToClientPrefix: output.slice(68, 72),
  };
}

export class BleCipher {
  constructor(private readonly keys: BleSessionKeys) {}

  private context(direction: BleDirection, messageId: number, sequence: number) {
    const key = direction === 'clientToServer' ? this.keys.clientToServerKey : this.keys.serverToClientKey;
    const prefix = direction === 'clientToServer' ? this.keys.clientToServerPrefix : this.keys.serverToClientPrefix;
    const iv = concat(prefix, sequenceBytes(sequence));
    const aad = utf8ToBytes(`P003-BLE-v1|${this.keys.sessionId}|${messageId}`);
    return { key, iv, aad };
  }

  encrypt(direction: BleDirection, messageId: number, sequence: number, plaintext: Uint8Array) {
    const { key, iv, aad } = this.context(direction, messageId, sequence);
    const encrypted = gcm(key, iv, aad).encrypt(plaintext);
    const body = concat(sequenceBytes(sequence), encrypted);
    if (body.length > 2048) throw new Error('BLE 加密消息超过 2048 字节');
    return body;
  }

  decrypt(direction: BleDirection, messageId: number, body: Uint8Array) {
    if (body.length < 25 || body.length > 2048) throw new Error('BLE 加密消息长度无效');
    const sequence = body.slice(0, 8).reduce((value, byte) => value * 256 + byte, 0);
    const { key, iv, aad } = this.context(direction, messageId, sequence);
    return gcm(key, iv, aad).decrypt(body.slice(8));
  }
}
