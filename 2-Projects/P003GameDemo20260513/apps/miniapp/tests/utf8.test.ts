import { afterEach, describe, expect, it, vi } from 'vitest';
import { utf8ToBytes } from '../src/services/utf8';

afterEach(() => { vi.unstubAllGlobals(); });

describe('真机 UTF-8 编码', () => {
  it.each(['', 'HELLO', '中文 Wi-Fi', 'é😀', '\ud800', '\udc00', '\ud800A', '\0'])('无需 TextEncoder 编码 %j', text => {
    const expected = Uint8Array.from(Buffer.from(text, 'utf8'));
    vi.stubGlobal('TextEncoder', undefined);
    expect(utf8ToBytes(text)).toEqual(expected);
  });
});
