import { describe, expect, it, vi } from 'vitest';
import { BleCipher, createBleKeyPair, decodeP256Spki, deriveBleSessionKeys, encodeP256Spki } from '../src/services/bleCrypto';

const sessionId = '0123456789abcdef0123456789abcdef';
const client = createBleKeyPair(new Uint8Array(32).fill(1));
const server = createBleKeyPair(new Uint8Array(32).fill(2));
const clientNonce = Uint8Array.from({ length: 16 }, (_, i) => i);
const serverNonce = Uint8Array.from({ length: 16 }, (_, i) => i + 16);

function cipher() {
  return new BleCipher(deriveBleSessionKeys({ sessionId, clientSecretKey: client.secretKey, serverPublicKey: server.publicKey, clientNonce, serverNonce }));
}

describe('P003 BLE 加密握手', () => {
  it('P-256 公钥与 DER SPKI 可无损转换', () => {
    const encoded = encodeP256Spki(client.publicKey);
    expect(encoded).toHaveLength(91);
    expect(decodeP256Spki(encoded)).toEqual(client.publicKey);
    expect(() => decodeP256Spki(encoded.slice(1))).toThrow('SPKI');
  });

  it('派生双向独立密钥并按协议加密和解密', () => {
    const ble = cipher();
    const plaintext = new TextEncoder().encode('{"reply_to":1,"status":"READY"}');
    const body = ble.encrypt('serverToClient', 7, 0, plaintext);
    expect(body).toHaveLength(8 + plaintext.length + 16);
    expect(ble.decrypt('serverToClient', 7, body)).toEqual(plaintext);
    const changed = body.slice(); changed[changed.length - 1] ^= 1;
    expect(() => ble.decrypt('serverToClient', 7, changed)).toThrow();
  });

  it('不同方向和 sequence 使用不同密文', () => {
    const ble = cipher();
    const plaintext = Uint8Array.from([1, 2, 3]);
    const first = ble.encrypt('clientToServer', 2, 0, plaintext);
    const next = ble.encrypt('clientToServer', 2, 1, plaintext);
    const reverse = ble.encrypt('serverToClient', 2, 0, plaintext);
    expect(first).not.toEqual(next);
    expect(first).not.toEqual(reverse);
  });

  it('微信没有全局 crypto 时仍能生成公钥并派生会话密钥', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      const keyPair = createBleKeyPair(new Uint8Array(32).fill(1), new Uint8Array(16).fill(3));
      const keys = deriveBleSessionKeys({ sessionId, clientSecretKey: keyPair.secretKey, serverPublicKey: server.publicKey, clientNonce, serverNonce, blindingBytes: new Uint8Array(16).fill(4) });
      expect(keys.clientToServerKey).toHaveLength(32);
      expect(globalThis.crypto).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
});
