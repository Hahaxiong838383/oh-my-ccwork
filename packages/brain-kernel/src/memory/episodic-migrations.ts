import type Database from 'better-sqlite3';

type Migration = {
  readonly id: string;
  readonly apply: (database: Database.Database) => void;
};

const EPISODIC_MIGRATIONS: readonly Migration[] = [
  {
    id: '20260418_episodic_add_verification_status_column',
    apply(database: Database.Database): void {
      const columns = database
        .prepare("PRAGMA table_info('episodic_traces')")
        .all() as Array<{ name: string }>;

      if (columns.length === 0) return;

      const hasVerificationStatus = columns.some(column => column.name === 'verification_status');
      if (!hasVerificationStatus) {
        database.exec(
          `ALTER TABLE episodic_traces
           ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'verified'`,
        );
      }
    },
  },
  {
    id: '20260418_episodic_add_verification_audit_table',
    apply(database: Database.Database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS episodic_verification_audit (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          from_status TEXT CHECK(from_status IN ('verified','unverified','verified_by_m16')),
          requested_status TEXT NOT NULL CHECK(requested_status IN ('verified','unverified','verified_by_m16')),
          applied_status TEXT NOT NULL CHECK(applied_status IN ('verified','unverified','verified_by_m16')),
          source TEXT NOT NULL CHECK(source IN ('insert','flag_unverified','unflag_verified','sweeper')),
          reason TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          FOREIGN KEY(trace_id) REFERENCES episodic_traces(id)
        );
        CREATE INDEX IF NOT EXISTS idx_episodic_verification_audit_trace_ts
          ON episodic_verification_audit(trace_id, occurred_at DESC);
      `);
    },
  },
];

export function runEpisodicMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const run = database.transaction(() => {
    for (const migration of EPISODIC_MIGRATIONS) {
      const alreadyApplied = database.prepare(
        'SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1',
      ).get(migration.id) as { 1: number } | undefined;
      if (alreadyApplied) continue;

      migration.apply(database);
      database.prepare(
        'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
      ).run(migration.id, Date.now());
    }
  });

  // BEGIN IMMEDIATE：启动时抢占写锁，避免多实例并发迁移在 DEFERRED 阶段互相等待并触发 busy/死锁。
  run.immediate();
}
