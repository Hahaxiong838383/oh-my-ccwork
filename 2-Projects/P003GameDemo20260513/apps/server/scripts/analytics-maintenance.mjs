import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {configureAnalyticsWriter} from '../src/analytics/sqlite-policy.mjs';

function main() {
  const mode = process.argv[2] || 'rollup';
  const database = process.env.ANALYTICS_DB_PATH;
  if (!database || !isAbsolute(database) || !existsSync(database)) throw new Error('DATABASE_UNAVAILABLE');
  let result;
  if (mode === 'rollup') {
    const run = spawnSync(process.env.ANALYTICS_NODE_PATH || process.execPath, ['--max-old-space-size=256', './node_modules/tsx/dist/cli.mjs', './scripts/analytics-rollup.ts'], { encoding: 'utf8', timeout: 240000, maxBuffer: 65536 });
    if (run.status !== 0) throw new Error('ROLLUP_FAILED');
    result = JSON.parse(run.stdout.trim());
  } else if (mode === 'backup') {
    const destination = process.env.ANALYTICS_BACKUP_DIR || resolve('./backups/analytics-daily');
    const run = spawnSync('/usr/bin/python3', ['./scripts/analytics-backup.py', '--database', database, '--destination', destination, '--keep', '2'], { encoding: 'utf8', timeout: 90000, maxBuffer: 65536 });
    if (run.status !== 0) throw new Error('BACKUP_FAILED');
    result = JSON.parse(run.stdout.trim());
    const db = new DatabaseSync(database);
    try {
      configureAnalyticsWriter(db);
      db.prepare('INSERT INTO analytics_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('last_backup_success_ms', String(Date.now()));
    } finally { db.close(); }
  } else throw new Error('INVALID_MAINTENANCE_MODE');
  const partial = mode === 'rollup' && result.partial === true;
  console.log(JSON.stringify({ ok: mode === 'rollup' ? result.ok === true && !partial : true, partial, mode, result }));
}
try { main(); } catch { console.error('ANALYTICS_MAINTENANCE_FAILED'); process.exitCode = 1; }
