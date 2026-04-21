import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEvalResult } from '../eval/eval-scorer.js';
import type { EvalTask } from '../eval/eval-tasks.js';

const mockTask: EvalTask = {
  taskId: 'test-1',
  description: 'Test task',
  category: 'test',
  expectedBehavior: 'should work',
  scoringCriteria: { correctnessHint: '', completenessHint: '', efficiencyHint: '' },
  userMessage: 'test input',
  referenceAnswer: 'The function should handle TypeScript generics and return a validated result with proper error handling.',
};

describe('scoreEvalResult', () => {
  it('returns all zeros for empty response', () => {
    const scores = scoreEvalResult(mockTask, '', 1000, 500);
    assert.equal(scores.correctness, 0);
    assert.equal(scores.completeness, 0);
    assert.equal(scores.efficiency, 0);
    assert.equal(scores.total, 0);
  });

  it('returns all zeros for whitespace-only response', () => {
    const scores = scoreEvalResult(mockTask, '   \n\t  ', 1000, 500);
    assert.equal(scores.total, 0);
  });

  it('scores >0 for relevant response', () => {
    const response = 'Use TypeScript generics to validate the result and add error handling with try-catch.';
    const scores = scoreEvalResult(mockTask, response, 2000, 800);
    assert.ok(scores.correctness > 0, 'correctness should be > 0');
    assert.ok(scores.total > 0, 'total should be > 0');
    assert.ok(scores.total <= 1, 'total should be <= 1');
  });

  it('efficiency: fast + low tokens = high score', () => {
    const scores = scoreEvalResult(mockTask, 'TypeScript generics validated result', 1000, 500);
    assert.ok(scores.efficiency > 0.5);
  });

  it('efficiency: slow + high tokens = low score', () => {
    const scores = scoreEvalResult(mockTask, 'TypeScript generics validated result', 14000, 5500);
    assert.ok(scores.efficiency < 0.3);
  });

  it('efficiency: timeout (>15s) = zero latency score', () => {
    const scores = scoreEvalResult(mockTask, 'TypeScript generics', 16000, 500);
    assert.ok(scores.efficiency < 0.5); // only token part contributes
  });

  it('all scores clamped to [0, 1]', () => {
    const scores = scoreEvalResult(mockTask, 'x', 100, 100);
    assert.ok(scores.correctness >= 0 && scores.correctness <= 1);
    assert.ok(scores.completeness >= 0 && scores.completeness <= 1);
    assert.ok(scores.efficiency >= 0 && scores.efficiency <= 1);
    assert.ok(scores.total >= 0 && scores.total <= 1);
  });
});
