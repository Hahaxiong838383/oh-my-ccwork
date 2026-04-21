import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { taskComplexity } from '../flow/task-complexity.js';
import type { TaskRecord } from '@evodesk/shared';

const base: TaskRecord = {
  id: 'test-1',
  domain: 'test',
  toolCallsRequired: 0,
  estimatedSteps: 0,
  memoryRetrievalCount: 0,
  similarTaskSuccessRate: 0.5,
  isReversible: true,
  success: true,
  retryCount: 0,
  userCorrected: false,
  completedAt: Date.now(),
};

describe('taskComplexity', () => {
  it('returns low value for simple task', () => {
    const c = taskComplexity(base);
    assert.ok(c >= 0 && c <= 1, `complexity=${c} should be in [0,1]`);
    assert.ok(c < 0.3, `simple task complexity=${c} should be < 0.3`);
  });

  it('returns higher value for complex task', () => {
    const complex: TaskRecord = {
      ...base,
      toolCallsRequired: 8,
      estimatedSteps: 15,
      memoryRetrievalCount: 4,
      similarTaskSuccessRate: 0.1,
      isReversible: false,
    };
    const c = taskComplexity(complex);
    assert.ok(c > 0.3, `complex task complexity=${c} should be > 0.3`);
  });

  it('handles zero values gracefully', () => {
    const zero: TaskRecord = {
      ...base,
      toolCallsRequired: 0,
      estimatedSteps: 0,
      memoryRetrievalCount: 0,
      similarTaskSuccessRate: 0,
    };
    const c = taskComplexity(zero);
    assert.ok(Number.isFinite(c), 'should not be NaN or Infinity');
    assert.ok(c >= 0);
  });

  it('handles extreme values', () => {
    const extreme: TaskRecord = {
      ...base,
      toolCallsRequired: 100,
      estimatedSteps: 100,
      memoryRetrievalCount: 100,
      similarTaskSuccessRate: 0,
      isReversible: false,
    };
    const c = taskComplexity(extreme);
    assert.ok(c >= 0 && c <= 1, `extreme complexity=${c} should be in [0,1]`);
  });

  it('handles NaN/Infinity in fields', () => {
    const bad: TaskRecord = { ...base, toolCallsRequired: NaN, estimatedSteps: Infinity };
    const c = taskComplexity(bad);
    assert.ok(Number.isFinite(c), 'should handle NaN gracefully');
  });
});
