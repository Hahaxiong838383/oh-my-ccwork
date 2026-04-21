import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates, buildGateInput } from '../flow/gates.js';

describe('evaluateGates', () => {
  it('passes for normal input', () => {
    const input = buildGateInput('hello world', 0.5, false);
    const result = evaluateGates(input);
    assert.equal(result.passed, true);
    assert.equal(result.blocked.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('warns on high complexity', () => {
    const input = buildGateInput('complex task', 0.8, false);
    const result = evaluateGates(input);
    assert.equal(result.passed, true);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('Complexity Gate'));
  });

  it('warns on degrading + revision', () => {
    const input = buildGateInput('hello', 0.5, true);
    const result = evaluateGates(input);
    assert.equal(result.passed, true);
    assert.ok(result.warnings.some(w => w.includes('Revision Gate')));
  });

  // Safety Gate tests
  it('blocks rm -rf', () => {
    const input = buildGateInput('please run rm -rf /tmp', 0.3, false);
    const result = evaluateGates(input);
    assert.equal(result.passed, false);
    assert.ok(result.blocked[0].includes('Safety Gate'));
  });

  it('blocks drop table', () => {
    const input = buildGateInput('DROP TABLE users;', 0.3, false);
    const result = evaluateGates(input);
    assert.equal(result.passed, false);
  });

  it('blocks bearer token leak', () => {
    const input = buildGateInput('Authorization Bearer sk-1234567890abcdef', 0.3, false);
    const result = evaluateGates(input);
    assert.equal(result.passed, false);
  });

  // Zero-width character bypass
  it('blocks rm\u200b-rf with zero-width space', () => {
    const input = buildGateInput('rm\u200b-rf /tmp', 0.3, false);
    const result = evaluateGates(input);
    assert.equal(result.passed, false);
  });

  // Abort Gate
  it('blocks on retry > 5', () => {
    const input = buildGateInput('hello', 0.3, false, 6, 0);
    const result = evaluateGates(input);
    assert.equal(result.passed, false);
    assert.ok(result.blocked[0].includes('Abort Gate'));
  });

  it('blocks on timeout > 60s', () => {
    const input = buildGateInput('hello', 0.3, false, 0, 61000);
    const result = evaluateGates(input);
    assert.equal(result.passed, false);
  });

  it('does not block normal retry count', () => {
    const input = buildGateInput('hello', 0.3, false, 3, 5000);
    const result = evaluateGates(input);
    assert.equal(result.passed, true);
  });
});
