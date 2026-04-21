import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  closeDb,
  getEpisodicTrace,
  initDb,
  insertEpisodicTrace,
} from '../memory/memory-db.js';
import {
  DEFAULT_EPISODIC_VERIFICATION_SLA_MS,
  sweepUnverifiedEpisodics,
} from '../memory/episodic-sweeper.js';

let tmpRoot: string;

beforeEach(() => {
  closeDb();
  if (!tmpRoot) {
    tmpRoot = mkdtempSync(join(tmpdir(), 'evodesk-episodic-sweeper-'));
  }
  initDb(join(tmpRoot, `${randomUUID()}.db`));
});

after(() => {
  closeDb();
  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
  }
});

describe('episodic sweeper', () => {
  it('仅补验超过 SLA 的 unverified，并且幂等', () => {
    const now = Date.now();
    const oldTs = now - (DEFAULT_EPISODIC_VERIFICATION_SLA_MS + 1_000);
    const freshTs = now - 1_000;

    insertEpisodicTrace({
      id: 'trace-overdue-1',
      event: 'overdue trace',
      timestamp: oldTs,
      verificationStatus: 'unverified',
    });
    insertEpisodicTrace({
      id: 'trace-fresh-1',
      event: 'fresh trace',
      timestamp: freshTs,
      verificationStatus: 'unverified',
    });

    const visited: string[] = [];
    const firstSweep = sweepUnverifiedEpisodics({
      now,
      reverify: trace => {
        visited.push(trace.id);
        return 'verified';
      },
    });

    assert.deepEqual(visited, ['trace-overdue-1'], '只应处理超过 SLA 的条目');
    assert.equal(firstSweep.scanned, 1);
    assert.equal(firstSweep.verified, 1);
    assert.equal(firstSweep.stillUnverified, 0);
    assert.equal(getEpisodicTrace('trace-overdue-1')?.verificationStatus, 'verified_by_m16');
    assert.equal(getEpisodicTrace('trace-fresh-1')?.verificationStatus, 'unverified');

    const secondSweep = sweepUnverifiedEpisodics({ now, reverify: () => 'verified' });
    assert.equal(secondSweep.scanned, 0, '重复 sweep 不应重复处理已补验条目');
  });

  it('补验拒绝路径保持 unverified 并触发 warn hook', () => {
    const now = Date.now();
    const oldTs = now - (DEFAULT_EPISODIC_VERIFICATION_SLA_MS + 5_000);

    insertEpisodicTrace({
      id: 'trace-reject-1',
      event: 'need manual review',
      timestamp: oldTs,
      verificationStatus: 'unverified',
    });

    const warnings: string[] = [];
    const result = sweepUnverifiedEpisodics({
      now,
      reverify: () => 'rejected',
      onWarn: message => warnings.push(message),
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.verified, 0);
    assert.equal(result.stillUnverified, 1);
    assert.equal(getEpisodicTrace('trace-reject-1')?.verificationStatus, 'unverified');
    assert.ok(warnings.includes('overdue_unverified_detected'));
    assert.ok(warnings.includes('reverify_rejected'));
  });
});
