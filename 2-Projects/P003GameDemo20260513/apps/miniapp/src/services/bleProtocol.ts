export type BleMessage = { type: number; messageId: number; payload: Uint8Array };

const HEADER_SIZE = 8;
const FRAGMENT_SIZE = 12;
const MAX_MESSAGE_SIZE = 2048;

export function fragmentMessage(type: number, messageId: number, payload: Uint8Array): Uint8Array[] {
  if (![0x01, 0x02, 0x81, 0x82, 0xff].includes(type) || !Number.isInteger(messageId) || messageId < 1 || messageId > 65535 || payload.length < 1 || payload.length > MAX_MESSAGE_SIZE) throw new Error('BLE 消息参数无效');
  const count = Math.ceil(payload.length / FRAGMENT_SIZE);
  return Array.from({ length: count }, (_, index) => {
    const part = payload.subarray(index * FRAGMENT_SIZE, (index + 1) * FRAGMENT_SIZE);
    const frame = new Uint8Array(HEADER_SIZE + part.length);
    frame.set([0xa7, 1, type, messageId & 255, messageId >> 8, index, count, part.length]);
    frame.set(part, HEADER_SIZE);
    return frame;
  });
}

export class BleReassembler {
  private pending: { type: number; messageId: number; count: number; startedAt: number; frames: Uint8Array[] } | null = null;

  reset() { this.pending = null; }

  push(frame: Uint8Array, now = Date.now()): BleMessage | null {
    if (this.pending && now - this.pending.startedAt >= 15000) {
      this.reset();
      throw new Error('BLE 消息重组超时');
    }
    if (frame.length < 9 || frame.length > 20 || frame[0] !== 0xa7 || frame[1] !== 1 || ![0x01, 0x02, 0x81, 0x82, 0xff].includes(frame[2])) throw new Error('BLE 分片头无效');
    const messageId = frame[3] | (frame[4] << 8);
    const index = frame[5];
    const count = frame[6];
    const length = frame[7];
    if (!messageId || count < 1 || count > 171 || index >= count || length < 1 || length > FRAGMENT_SIZE || frame.length !== HEADER_SIZE + length || (index < count - 1 && length !== FRAGMENT_SIZE)) throw new Error('BLE 分片格式无效');
    const pending = this.pending;
    if (!pending) {
      if (index !== 0) throw new Error('BLE 分片乱序');
      this.pending = { type: frame[2], messageId, count, startedAt: now, frames: [] };
    } else if (pending.type !== frame[2] || pending.messageId !== messageId || pending.count !== count) {
      this.reset();
      throw new Error('BLE 消息交错');
    }
    const current = this.pending!;
    if (index === current.frames.length - 1 && current.frames[index].every((value, i) => value === frame[i]) && current.frames[index].length === frame.length) return null;
    if (index !== current.frames.length) {
      this.reset();
      throw new Error('BLE 分片乱序');
    }
    current.frames.push(frame.slice());
    if (current.frames.length !== count) return null;
    const size = current.frames.reduce((total, item) => total + item[7], 0);
    if (size > MAX_MESSAGE_SIZE) {
      this.reset();
      throw new Error('BLE 消息超过 2048 字节');
    }
    const payload = new Uint8Array(size);
    let offset = 0;
    for (const item of current.frames) { payload.set(item.subarray(HEADER_SIZE), offset); offset += item[7]; }
    this.reset();
    return { type: frame[2], messageId, payload };
  }
}

export function validateWifiCredentials(ssid: string, password: string): string | null {
  if (!ssid || ssid.includes('\0')) return 'Wi-Fi 名称不能为空，也不能包含空字符';
  const bytes = Array.from(ssid).reduce((size, char) => size + (char.codePointAt(0)! <= 0x7f ? 1 : char.codePointAt(0)! <= 0x7ff ? 2 : char.codePointAt(0)! <= 0xffff ? 3 : 4), 0);
  if (bytes > 32) return 'Wi-Fi 名称不能超过 32 字节';
  if (password !== '' && !(/^[\x20-\x7e]{8,63}$/.test(password) || /^[0-9a-fA-F]{64}$/.test(password))) return 'Wi-Fi 密码需为 8–63 位可打印 ASCII 字符，或 64 位十六进制密钥';
  return null;
}
