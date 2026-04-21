import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDegrading, degradationScore } from '../flow/degradation-detector.js';
import type { DegradationMetrics } from '@evodesk/shared';

const base: DegradationMetrics = {
  thinkingRatio: 0.5,
  templateSimilarity: 0.5,
  toolSkipRate: 0.3,
  verificationSkipped: false,
  firstDraftAccepted: false,
  taskComplexity: 0.5,
};

describe('isDegrading', () => {
  it('returns false when no signals triggered', () => {
    assert.equal(isDegrading(base), false);
  });

  it('returns false with only 1 signal (thinkingRatio < 0.3)', () => {
    assert.equal(isDegrading({ ...base, thinkingRatio: 0.25 }), false);
  });

  it('returns true with 2 signals (low thinking + high template)', () => {
    assert.equal(isDegrading({ ...base, thinkingRatio: 0.1, templateSimilarity: 0.9 }), true);
  });

  it('returns true with 2 signals (verification skipped + firstDraft accepted + high complexity)', () => {
    assert.equal(isDegrading({ ...base, verificationSkipped: true, firstDraftAccepted: true, taskComplexity: 0.8 }), true);
  });

  // 边界值测试
  it('boundary: thinkingRatio=0.299 triggers signal', () => {
    assert.equal(isDegrading({ ...base, thinkingRatio: 0.299, templateSimilarity: 0.851 }), true);
  });

  it('boundary: thinkingRatio=0.301 does NOT trigger signal', () => {
    assert.equal(isDegrading({ ...base, thinkingRatio: 0.301, templateSimilarity: 0.851 }), false);
  });

  it('boundary: templateSimilarity=0.849 does NOT trigger signal', () => {
    assert.equal(isDegrading({ ...base, thinkingRatio: 0.25, templateSimilarity: 0.849 }), false);
  });

  it('boundary: toolSkipRate=0.601 triggers signal', () => {
    assert.equal(isDegrading({ ...base, thinkingRatio: 0.25, toolSkipRate: 0.601 }), true);
  });

  it('firstDraftAccepted + low complexity does NOT trigger combined signal', () => {
    assert.equal(isDegrading({ ...base, thinkingRatio: 0.25, firstDraftAccepted: true, taskComplexity: 0.3 }), false);
  });

  it('handles NaN/Infinity gracefully', () => {
    assert.equal(isDegrading({ ...base, thinkingRatio: NaN, templateSimilarity: Infinity }), false);
  });
});

describe('degradationScore', () => {
  it('returns 0 for healthy metrics', () => {
    assert.equal(degradationScore(base), 0);
  });

  it('returns >0 for degraded metrics', () => {
    const score = degradationScore({ ...base, thinkingRatio: 0.1, templateSimilarity: 0.95 });
    assert.ok(score > 0);
    assert.ok(score <= 1);
  });

  it('max score is capped at 1', () => {
    const score = degradationScore({
      thinkingRatio: 0, templateSimilarity: 1, toolSkipRate: 1,
      verificationSkipped: true, firstDraftAccepted: true, taskComplexity: 1,
    });
    assert.ok(score <= 1);
  });
});
