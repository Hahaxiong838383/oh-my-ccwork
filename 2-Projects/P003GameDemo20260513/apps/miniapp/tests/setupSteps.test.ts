import { describe, expect, it } from 'vitest';
import { nextSkippedStep } from '../src/setupSteps';

describe('首次使用流程的逐页跳过', () => {
  it.each([
    ['add', 'login'],
    ['login', 'permissions'],
    ['permissions', 'bluetooth'],
    ['bluetooth', 'location'],
    ['location', 'found'],
  ] as const)('%s 仅进入下一页 %s', (current, next) => {
    expect(nextSkippedStep(current)).toBe(next);
  });
  it('设备搜索之后不会因跳过入口进入配网', () => {
    expect(nextSkippedStep('found')).toBe('found');
  });
});
