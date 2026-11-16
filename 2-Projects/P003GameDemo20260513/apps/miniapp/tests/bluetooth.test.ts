import { describe, expect, it, vi } from 'vitest';
import { filterReaderDevices } from '../src/services/bluetooth';

vi.mock('@tarojs/taro', () => ({ default: {} }));

describe('附近读写台筛选', () => {
  it('只展示 P003 广播名对应的 Max 和 Ultra，按 deviceId 去重', () => {
    expect(filterReaderDevices([
      { deviceId: 'a', localName: 'EyesCare Max-01', name: '' },
      { deviceId: 'b', localName: '', name: 'EyesCare Ultra-02' },
      { deviceId: 'a', localName: 'EyesCare Max-01', name: '' },
      { deviceId: 'c', localName: '耳机', name: '' },
      { deviceId: 'd', localName: 'EyesCare Max', name: '' },
    ])).toEqual([{ id: 'a', name: 'EyesCare Max-01' }, { id: 'b', name: 'EyesCare Ultra-02' }]);
  });
});
