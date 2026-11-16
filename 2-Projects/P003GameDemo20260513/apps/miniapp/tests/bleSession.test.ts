import { afterEach, describe, expect, it, vi } from 'vitest';
import Taro from '@tarojs/taro';
import { BleSession } from '../src/services/bleSession';

vi.mock('@tarojs/taro', () => ({ default: {
  createBLEConnection: vi.fn().mockResolvedValue({}),
  stopBluetoothDevicesDiscovery: vi.fn().mockResolvedValue({}),
  onBLEConnectionStateChange: vi.fn(),
  onBLECharacteristicValueChange: vi.fn(),
  getBLEDeviceServices: vi.fn().mockResolvedValue({ services: [{ uuid: '0000FFFF-0000-1000-8000-00805F9B34FB' }] }),
  getBLEDeviceCharacteristics: vi.fn().mockResolvedValue({ characteristics: [
    { uuid: '0000FF01-0000-1000-8000-00805F9B34FB', properties: { write: true } },
    { uuid: '0000FF02-0000-1000-8000-00805F9B34FB', properties: { notify: true } },
  ] }),
  notifyBLECharacteristicValueChange: vi.fn().mockResolvedValue({}),
  getRandomValues: vi.fn().mockResolvedValue({ randomValues: Uint8Array.from({ length: 96 }, (_, i) => i + 1).buffer }),
  arrayBufferToBase64: (value: ArrayBuffer) => Buffer.from(value).toString('base64'),
  writeBLECharacteristicValue: vi.fn().mockRejectedValue(new Error('写入测试中断')),
  offBLECharacteristicValueChange: vi.fn(),
  offBLEConnectionStateChange: vi.fn(),
  closeBLEConnection: vi.fn().mockResolvedValue({}),
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('P003 真机 BLE 握手', () => {
  it('没有全局 crypto 和 TextEncoder 时仍生成并写入 HELLO', async () => {
    vi.stubGlobal('crypto', undefined);
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubEnv('TARO_ENV', 'weapp');
    const session = new BleSession({ id: 'device-1', name: 'EyesCare Max-FA6E-0006' });
    await expect(session.connect()).rejects.toThrow('writeBLECharacteristicValue(HELLO): 写入测试中断');
    expect(Taro.getRandomValues).toHaveBeenCalledWith({ length: 96 });
    expect(Taro.writeBLECharacteristicValue).toHaveBeenCalled();
  });
});
