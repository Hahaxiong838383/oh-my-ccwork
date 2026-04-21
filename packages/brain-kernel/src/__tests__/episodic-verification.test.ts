import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  initDb,
  closeDb,
  getDb,
  insertEpisodicTrace,
  getEpisodicTrace,
  flagEpisodicUnverified,
  unflagEpisodicVerified,
  listUnverifiedEpisodics,
  listEpisodicVerificationAudit,
} from '../memory/memory-db.js';

// V1.3.12（P0-2 Gemini 评审修复）单测：
// 验证 episodic_traces.verification_status 三态契约 + 辅助函数
// 对应 M16-spec v1.0.2 § 下游消费者规则

let tmpDir: string;
let dbPath: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'evodesk-episodic-'));
  dbPath = join(tmpDir, 'test.db');
  initDb(dbPath);
});

after(() => {
  closeDb();
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

describe('episodic_traces.verification_status', () => {
  it('默认状态是 verified（M16 在线场景）', () => {
    // V1.3.12 契约：insertEpisodicTrace 不传 verificationStatus 时默认 'verified'
    insertEpisodicTrace({
      id: 'trace-default-1',
      event: '用户问：TypeScript 和 JavaScript 的区别？',
      context: 'session=s1',
      timestamp: Date.now(),
    });

    const row = getEpisodicTrace('trace-default-1');
    assert.ok(row, 'trace 应该成功写入');
    assert.equal(row?.verificationStatus, 'verified', '默认状态必须是 verified');
    assert.equal(row?.userId, 'default', 'user_id 默认 default');
  });

  it('flagEpisodicUnverified + unflagEpisodicVerified 完整闭环', () => {
    // 场景：M16 offline 时写入的 trace 先标 unverified，
    // M16 恢复后补验通过标回 verified_by_m16
    insertEpisodicTrace({
      id: 'trace-flag-1',
      event: '用户随口提及 nginx',
      timestamp: Date.now(),
      verificationStatus: 'unverified', // 模拟 M16 offline 写入
    });

    // 初始：unverified
    let row = getEpisodicTrace('trace-flag-1');
    assert.equal(row?.verificationStatus, 'unverified', 'M16 offline 写入应为 unverified');

    // listUnverifiedEpisodics 应能找到这条记录
    const unverified = listUnverifiedEpisodics();
    assert.ok(
      unverified.some(r => r.id === 'trace-flag-1'),
      'listUnverifiedEpisodics 必须返回 unverified 记录',
    );

    // 反向测试：对已 unverified 再 flag，仍为 unverified（幂等）
    const flagResult = flagEpisodicUnverified('trace-flag-1');
    assert.equal(flagResult, true, 'flagEpisodicUnverified 成功返回 true');
    row = getEpisodicTrace('trace-flag-1');
    assert.equal(row?.verificationStatus, 'unverified');

    // M16 恢复补验通过：unflagEpisodicVerified
    const unflagResult = unflagEpisodicVerified('trace-flag-1');
    assert.equal(unflagResult, true, 'unflagEpisodicVerified 成功返回 true');

    row = getEpisodicTrace('trace-flag-1');
    assert.equal(
      row?.verificationStatus,
      'verified_by_m16',
      '补验后状态必须是 verified_by_m16（保留追溯标记）',
    );

    // 验证后不在 unverified 列表里
    const unverifiedAfter = listUnverifiedEpisodics();
    assert.ok(
      !unverifiedAfter.some(r => r.id === 'trace-flag-1'),
      '补验后不再出现在 unverified 列表',
    );

    // 不存在的 traceId 返回 false（边界）
    assert.equal(flagEpisodicUnverified('not-exist'), false);
    assert.equal(unflagEpisodicVerified('not-exist'), false);
  });

  it('受保护 upsert 不允许 verified/verified_by_m16 回滚到 unverified，并保留审计链', () => {
    insertEpisodicTrace({
      id: 'trace-protect-1',
      event: '第一次写入',
      context: 'ctx-v1',
      timestamp: Date.now() - 1000,
      verificationStatus: 'verified',
    });

    // 试图把 verified 回滚成 unverified（应被阻止）
    insertEpisodicTrace({
      id: 'trace-protect-1',
      event: '第二次写入',
      context: 'ctx-v2',
      timestamp: Date.now(),
      verificationStatus: 'unverified',
    });

    const rowAfterRollbackAttempt = getEpisodicTrace('trace-protect-1');
    assert.equal(
      rowAfterRollbackAttempt?.verificationStatus,
      'verified',
      '已有 verified 不允许回滚到 unverified',
    );
    assert.equal(rowAfterRollbackAttempt?.context, 'ctx-v2', '业务字段允许更新');

    // verified_by_m16 场景单独验证：先从 unverified 升级，再尝试回滚
    insertEpisodicTrace({
      id: 'trace-protect-2',
      event: 'M16 recover check',
      timestamp: Date.now(),
      verificationStatus: 'unverified',
    });
    const upgraded = unflagEpisodicVerified('trace-protect-2');
    assert.equal(upgraded, true);
    const downgraded = flagEpisodicUnverified('trace-protect-2');
    assert.equal(downgraded, true, '存在 trace 时返回 true，即使状态变更被保护拦截');

    const rowAfterSecondAttempt = getEpisodicTrace('trace-protect-2');
    assert.equal(
      rowAfterSecondAttempt?.verificationStatus,
      'verified_by_m16',
      'verified_by_m16 不允许被回滚到 unverified',
    );

    const auditRows = [
      ...listEpisodicVerificationAudit('trace-protect-1'),
      ...listEpisodicVerificationAudit('trace-protect-2'),
    ];
    assert.ok(auditRows.length >= 5, '每次状态写入/转换都应留审计链');
    assert.ok(
      auditRows.some(row => row.reason === 'rollback_to_unverified_blocked'),
      '应记录回滚拦截原因',
    );

    // 竞态回归：模拟「事务 A 在读状态，事务 B 试图在中间写入」的交错窗口。
    // insertEpisodicTrace 使用 BEGIN IMMEDIATE 后，事务 B 必须被阻塞（busy），避免 TOCTOU。
    insertEpisodicTrace({
      id: 'trace-protect-race',
      event: 'race baseline',
      timestamp: Date.now(),
      verificationStatus: 'verified',
    });

    const primary = getDb();
    const secondary = new Database(dbPath);
    secondary.pragma('journal_mode = WAL');
    secondary.pragma('busy_timeout = 0');
    secondary.pragma('foreign_keys = ON');

    const mutablePrimary = primary as unknown as {
      prepare: Database.Database['prepare'];
    };
    const originalPrepare = primary.prepare.bind(primary);
    let raceAttempted = false;
    let raceBlocked = false;

    mutablePrimary.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes('SELECT verification_status FROM episodic_traces WHERE id = ?')) {
        return statement;
      }

      return {
        get: (...args: unknown[]) => {
          if (!raceAttempted) {
            raceAttempted = true;
            try {
              secondary.exec('BEGIN IMMEDIATE');
              secondary.prepare(
                'UPDATE episodic_traces SET verification_status = ? WHERE id = ?',
              ).run('unverified', 'trace-protect-race');
              secondary.exec('COMMIT');
            } catch {
              raceBlocked = true;
              try { secondary.exec('ROLLBACK'); } catch { /* ignore */ }
            }
          }
          return statement.get(...args);
        },
      } as unknown as ReturnType<Database.Database['prepare']>;
    }) as Database.Database['prepare'];

    try {
      insertEpisodicTrace({
        id: 'trace-protect-race',
        event: 'race overwrite attempt',
        timestamp: Date.now(),
        verificationStatus: 'unverified',
      });
    } finally {
      mutablePrimary.prepare = originalPrepare as Database.Database['prepare'];
      secondary.close();
    }

    assert.equal(raceAttempted, true, '应触发并发写入尝试');
    assert.equal(raceBlocked, true, 'BEGIN IMMEDIATE 应阻止中间写入交错');
    assert.equal(
      getEpisodicTrace('trace-protect-race')?.verificationStatus,
      'verified',
      '并发交错场景下不允许回滚到 unverified',
    );
  });
});
