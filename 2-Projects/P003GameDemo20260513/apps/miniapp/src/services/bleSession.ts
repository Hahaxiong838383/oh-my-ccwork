import Taro from '@tarojs/taro';
import { p256 } from '@noble/curves/nist.js';
import { utf8ToBytes } from './utf8';
import { fragmentMessage, BleReassembler, type BleMessage } from './bleProtocol';
import { BleCipher, createBleKeyPair, decodeP256Spki, deriveBleSessionKeys, encodeP256Spki } from './bleCrypto';
import type { NearbyDevice } from './bluetooth';

const SERVICE_ID = '0000FFFF-0000-1000-8000-00805F9B34FB';
const WRITE_ID = '0000FF01-0000-1000-8000-00805F9B34FB';
const NOTIFY_ID = '0000FF02-0000-1000-8000-00805F9B34FB';
const INTERMEDIATE = new Set(['WIFI_CONNECTING', 'SCAN_BUSY']);
const SUCCESS = new Set(['READY', 'SCAN_COMPLETE', 'NETWORK_READY']);

export type BleHandshakeResult = { sessionId: string; deviceSn: string; identityMode: string };
export type BleWifiNetwork = { ssid: string; signal_level?: number; requires_password?: boolean };
type JsonRecord = Record<string, unknown>;
type Reply = JsonRecord & { reply_to?: number; status?: string; data?: JsonRecord };
type Waiter = { replyTo: number; resolve: (reply: Reply) => void; reject: (error: Error) => void; onUpdate?: (status: string) => void };

export class BleProtocolError extends Error {
  constructor(public readonly status: string, public readonly data?: JsonRecord) {
    super(status); this.name = 'BleProtocolError';
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function decodeUtf8(bytes: Uint8Array) {
  let output = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    if (first < 0x80) { output += String.fromCharCode(first); continue; }
    const extra = first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : first >= 0xc0 ? 1 : 0;
    if (!extra || i + extra > bytes.length) throw new Error('BLE JSON UTF-8 无效');
    let code = first & (extra === 3 ? 7 : extra === 2 ? 15 : 31);
    for (let j = 0; j < extra; j += 1) code = (code << 6) | (bytes[i++] & 63);
    output += code > 0xffff ? String.fromCharCode(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 1023)) : String.fromCharCode(code);
  }
  return output;
}
function parseJson(bytes: Uint8Array): JsonRecord {
  const value = JSON.parse(decodeUtf8(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BLE JSON 格式无效');
  return value as JsonRecord;
}
function bodySequence(body: Uint8Array) {
  return body.slice(0, 8).reduce((value, byte) => value * 256 + byte, 0);
}
function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export class BleSession {
  private readonly receiver = new BleReassembler();
  private cipher: BleCipher | null = null;
  private keyPair: ReturnType<typeof createBleKeyPair> | null = null;
  private clientNonce: Uint8Array | null = null;
  private sharedBlinding: Uint8Array | null = null;
  private helloReply: JsonRecord | null = null;
  private serverSequence = 0;
  private clientSequence = 0;
  private nextMessageId = 2;
  private queue: Promise<void> = Promise.resolve();
  private readyResolve: ((result: BleHandshakeResult) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private waiters: Waiter[] = [];
  private connected = false;
  private connectedAt = 0;
  private readonly onValueChange: (event: { deviceId: string; characteristicId: string; value: ArrayBuffer }) => void;
  private readonly onConnectionChange: (event: { deviceId: string; connected: boolean }) => void;

  constructor(private readonly device: NearbyDevice) {
    this.onValueChange = event => {
      if (event.deviceId !== this.device.id || event.characteristicId.toLowerCase() !== NOTIFY_ID.toLowerCase()) return;
      this.queue = this.queue.then(() => this.receiveFrame(new Uint8Array(event.value))).catch(error => this.fail(error));
    };
    this.onConnectionChange = event => {
      if (event.deviceId === this.device.id && !event.connected && this.connected) this.fail(new Error('BLE 连接已断开'));
    };
  }

  async connect(): Promise<BleHandshakeResult> {
    if (process.env.TARO_ENV !== 'weapp') throw new Error('真实 BLE 握手请在微信小程序真机中运行');
    const ready = new Promise<BleHandshakeResult>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    let stage = 'createBLEConnection';
    try {
      try {
        await Taro.createBLEConnection({ deviceId: this.device.id, timeout: 10000 });
      } finally {
        await Taro.stopBluetoothDevicesDiscovery().catch(() => undefined);
      }
      this.connected = true; this.connectedAt = Date.now();
      Taro.onBLEConnectionStateChange(this.onConnectionChange);
      Taro.onBLECharacteristicValueChange(this.onValueChange);
      stage = 'getBLEDeviceServices';
      const { services } = await Taro.getBLEDeviceServices({ deviceId: this.device.id });
      if (!services.some(item => item.uuid.toLowerCase() === SERVICE_ID.toLowerCase())) throw new Error('设备未提供 P003 BLE 服务');
      stage = 'getBLEDeviceCharacteristics';
      const { characteristics } = await Taro.getBLEDeviceCharacteristics({ deviceId: this.device.id, serviceId: SERVICE_ID });
      const write = characteristics.find(item => item.uuid.toLowerCase() === WRITE_ID.toLowerCase());
      const notify = characteristics.find(item => item.uuid.toLowerCase() === NOTIFY_ID.toLowerCase());
      if (!write?.properties.write || !notify?.properties.notify) throw new Error('BLE 写入或通知特征不可用');
      stage = 'notifyBLECharacteristicValueChange';
      await Taro.notifyBLECharacteristicValueChange({ deviceId: this.device.id, serviceId: SERVICE_ID, characteristicId: NOTIFY_ID, state: true, type: 'notification' });
      stage = 'getRandomValues';
      const { randomValues } = await Taro.getRandomValues({ length: 96 });
      if (randomValues.byteLength !== 96) throw new Error('微信安全随机数长度无效');
      const random = new Uint8Array(randomValues);
      this.keyPair = createBleKeyPair(p256.utils.randomSecretKey(random.slice(0, 48)), random.slice(64, 80));
      this.clientNonce = random.slice(48, 64);
      this.sharedBlinding = random.slice(80);
      const hello = JSON.stringify({ client_public_key: Taro.arrayBufferToBase64(buffer(encodeP256Spki(this.keyPair.publicKey))), client_nonce: Taro.arrayBufferToBase64(buffer(this.clientNonce)) });
      stage = 'writeBLECharacteristicValue(HELLO)';
      await this.write(1, 1, utf8ToBytes(hello));
      stage = 'wait READY';
      return await withTimeout(ready, 20000, 'BLE 握手超时');
    } catch (error) {
      const detail = error as { errCode?: number | string; errMsg?: string; message?: string } | null;
      const reason = detail?.errMsg || detail?.message || String(error);
      const code = detail?.errCode === undefined ? '' : ` [${detail.errCode}]`;
      console.error('[P003 BLE]', new Date().toISOString(), stage, code, reason);
      await this.disconnect();
      throw new Error(`${stage}${code}: ${reason}`);
    }
  }

  private assertActive() {
    if (!this.connected || !this.cipher) throw new Error('BLE 会话尚未就绪');
    if (Date.now() - this.connectedAt >= 5 * 60 * 1000) throw new Error('SESSION_EXPIRED');
  }

  private nextRequestId() {
    const id = this.nextMessageId;
    this.nextMessageId = id >= 65535 ? 2 : id + 1;
    return id;
  }

  private async request(command: JsonRecord, timeout: number, onUpdate?: (status: string) => void): Promise<Reply> {
    this.assertActive();
    const messageId = this.nextRequestId();
    const sequence = this.clientSequence++;
    const payload = this.cipher!.encrypt('clientToServer', messageId, sequence, utf8ToBytes(JSON.stringify(command)));
    const waiter = new Promise<Reply>((resolve, reject) => { this.waiters.push({ replyTo: messageId, resolve, reject, onUpdate }); });
    try {
      await this.write(2, messageId, payload);
      return await withTimeout(waiter, timeout, 'BLE 命令等待超时');
    } catch (error) {
      this.waiters = this.waiters.filter(item => item.replyTo !== messageId);
      throw error;
    }
  }

  async scanWifi() {
    const reply = await this.request({ command: 'scan_wifi' }, 12000);
    const networks = (reply.data?.networks as unknown) || [];
    if (!Array.isArray(networks)) throw new Error('Wi-Fi 扫描结果格式无效');
    return networks.map(item => {
      const network = item as JsonRecord;
      return { ssid: String(network.ssid || ''), signal_level: Number(network.signal_level || 0), requires_password: network.requires_password !== false };
    }).filter(item => item.ssid);
  }

  async configureWifi(operationId: string, ssid: string, password: string, onUpdate?: (status: string) => void) {
    await this.request({ command: 'configure_wifi', operation_id: operationId, ssid, password }, 95000, onUpdate);
  }

  async queryStatus(operationId?: string) {
    return this.request({ command: 'status', ...(operationId ? { operation_id: operationId } : {}) }, 10000);
  }

  private async receiveFrame(frame: Uint8Array) {
    const message = this.receiver.push(frame);
    if (message) await this.receive(message);
  }

  private async receive(message: BleMessage) {
    const payload = message.payload;
    if (message.type === 0xff) throw new Error(String(parseJson(payload).error || 'BLE 协议错误'));
    if (message.type === 0x81) {
      const reply = parseJson(payload);
      if (reply.reply_to !== 1 || reply.protocol_version !== 1 || !/^[0-9a-f]{32}$/.test(String(reply.session_id || ''))) throw new Error('BLE HELLO_REPLY 无效');
      if (!this.keyPair || !this.clientNonce) throw new Error('BLE 客户端握手状态丢失');
      const serverPublicKey = decodeP256Spki(new Uint8Array(Taro.base64ToArrayBuffer(String(reply.server_public_key || ''))));
      const serverNonce = new Uint8Array(Taro.base64ToArrayBuffer(String(reply.server_nonce || '')));
      this.cipher = new BleCipher(deriveBleSessionKeys({ sessionId: String(reply.session_id), clientSecretKey: this.keyPair.secretKey, serverPublicKey, clientNonce: this.clientNonce, serverNonce, blindingBytes: this.sharedBlinding || undefined }));
      this.helloReply = reply;
      return;
    }
    if (message.type !== 0x82 || !this.helloReply || !this.cipher) return;
    const sequence = bodySequence(payload);
    if (sequence !== this.serverSequence) throw new Error('BLE 服务端 sequence 不连续');
    const reply = parseJson(this.cipher.decrypt('serverToClient', message.messageId, payload)) as Reply;
    this.serverSequence += 1;
    const status = String(reply.status || '');
    if (status === 'READY' && this.readyResolve) {
      if (reply.reply_to !== 1) throw new Error('BLE READY 关联消息错误');
      const deviceSn = String((reply.data as JsonRecord | undefined)?.device_sn || '');
      if (!deviceSn) throw new Error('BLE READY 缺少设备 SN');
      this.readyResolve({ sessionId: String(this.helloReply.session_id), deviceSn, identityMode: String(this.helloReply.identity_mode || '') });
      this.readyResolve = null; this.readyReject = null;
      return;
    }
    const waiter = this.waiters.find(item => item.replyTo === reply.reply_to);
    if (!waiter) return;
    if (INTERMEDIATE.has(status)) { waiter.onUpdate?.(status); return; }
    this.waiters = this.waiters.filter(item => item !== waiter);
    if (SUCCESS.has(status)) waiter.resolve(reply);
    else waiter.reject(new BleProtocolError(status || 'UNKNOWN_STATUS', reply.data));
  }

  private async write(type: number, messageId: number, payload: Uint8Array) {
    for (const frame of fragmentMessage(type, messageId, payload)) {
      await Taro.writeBLECharacteristicValue({ deviceId: this.device.id, serviceId: SERVICE_ID, characteristicId: WRITE_ID, value: buffer(frame), writeType: 'write' });
    }
  }

  private fail(error: unknown) {
    const reason = error instanceof Error ? error : new Error('BLE 会话失败');
    this.readyReject?.(reason);
    this.waiters.forEach(waiter => waiter.reject(reason)); this.waiters = [];
    void this.disconnect();
  }

  async disconnect() {
    this.connected = false;
    this.receiver.reset();
    this.cipher = null; this.keyPair = null; this.clientNonce = null; this.sharedBlinding = null; this.helloReply = null;
    try { Taro.offBLECharacteristicValueChange(this.onValueChange); } catch { /* 已释放或未注册。 */ }
    try { Taro.offBLEConnectionStateChange(this.onConnectionChange); } catch { /* 已释放或未注册。 */ }
    await Taro.closeBLEConnection({ deviceId: this.device.id }).catch(() => undefined);
  }
}
