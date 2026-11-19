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
    const archiveRoot=process.env.ANALYTICS_ARCHIVE_ROOT;
    if(archiveRoot&&!isAbsolute(archiveRoot))throw new Error('INVALID_ARCHIVE_ROOT');
    const args=archiveRoot?['./scripts/storage-backup-job.py','--database',database,'--root',archiveRoot]:['./scripts/analytics-backup.py', '--database', database, '--destination', destination, '--keep', '2'];
    // Inner work budget <=2h. This bound includes process shutdown margin, never HTTP.
    const run = spawnSync('/usr/bin/python3', args, { encoding: 'utf8', timeout: 7220000, maxBuffer: 1048576, killSignal:'SIGKILL' });
    if (run.status !== 0) throw new Error('BACKUP_FAILED');
    result = JSON.parse(run.stdout.trim());
    const db = new DatabaseSync(database);
    try {
      configureAnalyticsWriter(db);
      if(!archiveRoot||result.state==='published')db.prepare('INSERT INTO analytics_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('last_backup_success_ms', String(archiveRoot?result.manifest.created_at_ms:Date.now()));
    } finally { db.close(); }
  } else throw new Error('INVALID_MAINTENANCE_MODE');
  const partial = mode === 'rollup' && result.partial === true;
  console.log(JSON.stringify({ ok: mode === 'rollup' ? result.ok === true && !partial : true, partial, mode, result }));
}
try { main(); } catch { console.error('ANALYTICS_MAINTENANCE_FAILED'); process.exitCode = 1; }
