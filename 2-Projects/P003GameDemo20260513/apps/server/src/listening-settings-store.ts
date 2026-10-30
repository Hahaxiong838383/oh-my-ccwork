import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultListeningConfig, parseListeningConfig, parseListeningEditable, ListeningConfigError, type ListeningConfig } from './listening-settings.js';
interface Stored { revision: number; value_json: string; updated_at: number; updated_by: string }
export class ListeningSettingsStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS listening_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS listening_settings_audit (revision INTEGER PRIMARY KEY, operation TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  read() {
    const row = this.db.prepare('SELECT * FROM listening_settings WHERE id=1').get() as unknown as Stored | undefined;
    if (!row) return { config: defaultListeningConfig(), updated_at: null, updated_by: null };
    let config: ListeningConfig | null = null;
    try { config = parseListeningConfig(JSON.parse(row.value_json)); } catch { /* fail closed */ }
    if (!config || config.revision !== row.revision) throw new ListeningConfigError('corrupt_config');
    return { config, updated_at: row.updated_at, updated_by: row.updated_by };
  }
  history() {
    return this.db.prepare('SELECT revision,operation,actor,at FROM listening_settings_audit ORDER BY revision DESC LIMIT 20').all();
  }
  view() { return this.transaction(() => ({ ...this.read(), history: this.history() }), false); }
  private transaction<T>(fn: () => T, write = true): T {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private write(current: ListeningConfig, editable: unknown, actor: string, operation: string) {
    const parsed = parseListeningEditable(editable);
    if (!parsed) throw new ListeningConfigError('invalid_settings');
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new ListeningConfigError('revision_exhausted');
    if (!actor || actor.length > 128) throw new ListeningConfigError('invalid_actor');
    const next: ListeningConfig = { ...parsed, schema_version: 1, revision: current.revision + 1 };
    const at = Date.now();
    this.db.prepare('INSERT INTO listening_settings VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
      .run(next.revision, JSON.stringify(next), at, actor);
    this.db.prepare('INSERT INTO listening_settings_audit VALUES (?,?,?,?,?,?)')
      .run(next.revision, operation, actor, at, JSON.stringify(current), JSON.stringify(next));
    return next;
  }
  save(expectedRevision: number, editable: unknown, actor: string) {
    return this.transaction(() => {
      const { config } = this.read();
      if (config.revision !== expectedRevision) throw new ListeningConfigError('revision_conflict');
      return this.write(config, editable, actor, 'save');
    });
  }
  disable(actor: string) {
    // Reads current values under the write lock. Never overwrites concurrent tuning with a stale browser draft.
    return this.transaction(() => {
      const { config } = this.read(); const { schema_version, revision, ...editable } = config;
      return this.write(config, { ...editable, enabled: false }, actor, 'disable');
    });
  }
  restore(expectedRevision: number, targetRevision: number, actor: string) {
    return this.transaction(() => {
      const { config } = this.read();
      if (config.revision !== expectedRevision) throw new ListeningConfigError('revision_conflict');
      const row = this.db.prepare('SELECT after_json FROM listening_settings_audit WHERE revision=?').get(targetRevision) as { after_json: string } | undefined;
      let target = targetRevision === 1 ? defaultListeningConfig() : null;
      if (row) { try { target = parseListeningConfig(JSON.parse(row.after_json)); } catch { throw new ListeningConfigError('corrupt_config'); } }
      if (!target || target.revision !== targetRevision) throw new ListeningConfigError('revision_not_found');
      const { schema_version, revision, ...editable } = target;
      // Restoring settings never reopens the master gate. Enabling is a separate, readiness-checked action.
      return this.write(config, { ...editable, enabled: false }, actor, 'restore');
    });
  }
}
let instance: ListeningSettingsStore | undefined;
export function getListeningSettingsStore() {
  return instance ??= new ListeningSettingsStore(resolve(process.env.CONFIG_DB_PATH?.trim() || './data/config.db'));
}
