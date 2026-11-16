import { describe, expect, it } from 'vitest';
import { BleReassembler, fragmentMessage, validateWifiCredentials } from '../src/services/bleProtocol';

describe('P003 BLE 分包与重组', () => {
  it('按 20 字节上限分包，并在完整接收后恢复消息', () => {
    const body = Uint8Array.from({ length: 25 }, (_, i) => i);
    const frames = fragmentMessage(0x02, 258, body);
    expect(frames.map(frame => frame.length)).toEqual([20, 20, 9]);
    expect(Array.from(frames[0].slice(0, 8))).toEqual([0xa7, 1, 2, 2, 1, 0, 3, 12]);
    const receiver = new BleReassembler();
    expect(receiver.push(frames[0], 0)).toBeNull();
    expect(receiver.push(frames[0], 1)).toBeNull();
    expect(receiver.push(frames[1], 2)).toBeNull();
    expect(receiver.push(frames[2], 3)).toEqual({ type: 2, messageId: 258, payload: body });
  });

  it('拒绝乱序、错头、超时和超长消息', () => {
    const frames = fragmentMessage(1, 1, new Uint8Array(13));
    expect(() => new BleReassembler().push(frames[1], 0)).toThrow();
    const bad = frames[0].slice(); bad[0] = 0;
    expect(() => new BleReassembler().push(bad, 0)).toThrow();
    const receiver = new BleReassembler();
    receiver.push(frames[0], 0);
    expect(() => receiver.push(frames[1], 15000)).toThrow('超时');
    expect(() => fragmentMessage(1, 1, new Uint8Array(2049))).toThrow();
  });

  it('接受 2048 字节上限，拒绝接收端累计超过上限', () => {
    const max = fragmentMessage(2, 65535, new Uint8Array(2048));
    const receiver = new BleReassembler();
    let complete = null;
    for (const frame of max) complete = receiver.push(frame, 0);
    expect(complete?.payload).toHaveLength(2048);
    const tooLarge = Array.from({ length: 171 }, (_, index) => {
      const frame = new Uint8Array(20);
      frame.set([0xa7, 1, 2, 1, 0, index, 171, 12]);
      return frame;
    });
    const oversizedReceiver = new BleReassembler();
    for (const frame of tooLarge.slice(0, -1)) oversizedReceiver.push(frame, 0);
    expect(() => oversizedReceiver.push(tooLarge[170], 0)).toThrow('2048');
  });
});

describe('P003 Wi-Fi 参数', () => {
  it('接受开放网络、ASCII 密码和 64 位十六进制 PSK', () => {
    expect(validateWifiCredentials('家里 Wi-Fi', '')).toBeNull();
    expect(validateWifiCredentials('Home', '12345678')).toBeNull();
    expect(validateWifiCredentials('Home', 'a'.repeat(64))).toBeNull();
  });

  it('拒绝空 SSID、NUL、超过 32 字节和非法密码', () => {
    expect(validateWifiCredentials('', '12345678')).toMatch(/名称/);
    expect(validateWifiCredentials('A\0B', '12345678')).toMatch(/名称/);
    expect(validateWifiCredentials('中'.repeat(11), '12345678')).toMatch(/32/);
    expect(validateWifiCredentials('Home', '1234567')).toMatch(/密码/);
    expect(validateWifiCredentials('Home', 'é'.repeat(8))).toMatch(/密码/);
    expect(validateWifiCredentials('Home', 'g'.repeat(64))).toMatch(/密码/);
  });
});
