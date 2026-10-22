import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type RoutingClaim = { version: string; rule_id: string; weather?: import('./moji-weather.js').WeatherRequest; auto_weather?: import('./moji-weather.js').AutoWeatherRequest; place_weather?: import('./baidu-weather.js').PlaceWeatherRequest };
export type TaskRouting = RoutingClaim & { weather_enabled: boolean; auto_location_enabled?: boolean; baidu_weather_enabled?: boolean };
export type SearchOwner = { subject: string; session: string };
export type SearchResult = { weather?: import('./moji-weather.js').WeatherEvidence | import('./baidu-weather.js').BaiduWeatherEvidence; diagnostics?: import('./search-executor.js').SearchDiagnostics; text: string; sources: { title: string; url: string; date: string | null }[] };
export type SearchTask = SearchOwner & {
  id: string; key: string; turn: string; revision: number; routing?: TaskRouting;
  status: 'queued' | 'running' | 'ready' | 'delivered' | 'failed' | 'cancelled' | 'expired';
  createdAt: number; deadline: number; readyAt?: number;
  result?: SearchResult; error?: string; claim?: string;
  delivery?: 'claimed' | 'completed' | 'interrupted' | 'dropped' | 'unknown';
  diagnostics?: import('./search-executor.js').SearchDiagnostics;
  replays?: { previous: string; delivery: string; automatic: boolean; at: number }[];
};
type Options = {
  dbPath: string; execute: (query: string, signal: AbortSignal, owner: SearchTask) => Promise<SearchResult>;
  enabled: () => boolean; allowed: (subject: string) => boolean; now?: () => number;
  canSubmit?: (routing?: TaskRouting) => boolean;
  resolveRouting?: (owner: SearchOwner, claim: RoutingClaim) => TaskRouting;
  concurrency?: number; queueLimit?: number; dailyDeviceLimit?: number; dailyGlobalLimit?: number;
};
const LIVE = new Set(['queued', 'running', 'ready', 'failed']);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const fail = (code: string): never => { throw new Error(code); };

/** Conservative first release: only public, standalone questions, never raw conversation history. */
export function validateQuery(value: unknown): string {
  if (typeof value !== 'string') return fail('invalid_request');
  const q = value.normalize('NFKC').trim();
  if (!q || [...q].length > 128 || /[\x00-\x1f\x7f]/.test(q)) return fail('invalid_request');
  if (/(?:https?:|www\.|@|\b\d{7,}\b|BJP003|Bearer|密钥|密码|手机号|电话|身份证|家庭|住址|我家|我的|我们|学校|班级|同学|孩子|儿子|女儿)/i.test(q)) return fail('private_query');
  if (/(?:色情|裸照|自杀|自残|制毒|炸弹|杀人|人肉|开盒)/.test(q)) return fail('unsafe_query');
  return q;
}

/** Owns a separate ledger. No imports from conversation, memory or device control. */
export class SearchTasks {
  private db: DatabaseSync;
  private records = new Map<string, SearchTask>();
  private nextPurge = 0;
  private pending = new Map<string, string>();
  private active = new Map<string, AbortController>();
  private closed = false;
  private pumping = false;
  private now: () => number;
  constructor(private opts: Options) {
    this.now = opts.now ?? Date.now;
    mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(opts.dbPath);
    chmodSync(opts.dbPath, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=50;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, dedupe TEXT UNIQUE NOT NULL, subject TEXT NOT NULL,
        session TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_session ON tasks(subject,session);
      CREATE TABLE IF NOT EXISTS closed_sessions (subject TEXT, session TEXT, created INTEGER, PRIMARY KEY(subject,session));`);
    for (const row of this.db.prepare('SELECT body FROM tasks ORDER BY created,id').all() as { body: string }[]) {
      const t: SearchTask = JSON.parse(row.body); this.records.set(t.id, t);
    }
    // Never resume network work or a claimed delivery after process loss.
    for (const t of this.all()) {
      let changed = false;
      if (t.status === 'queued' || t.status === 'running') { t.status = 'failed'; t.error = 'process_interrupted'; t.readyAt = this.now(); changed = true; }
      if (t.claim && t.delivery === 'claimed') { t.delivery = 'unknown'; t.status = 'delivered'; changed = true; }
      if (changed) this.save(t);
    }
    this.tick();
  }
  private all(): SearchTask[] {
    return Array.from(this.records.values(), t => ({ ...t }));
  }
  private save(t: SearchTask) {
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(t.id, t.key, t.subject, t.session, t.createdAt, JSON.stringify(t));
    this.records.set(t.id, structuredClone(t));
  }
  get(owner: SearchOwner, id: string): SearchTask {
    const t = this.records.get(id);
    return t && t.subject === owner.subject && t.session === owner.session ? structuredClone(t) : fail('not_found');
  }
  submit(owner: SearchOwner, input: { turn: string; query: string; phase: string; protocol: number; replace?: string; routing?: RoutingClaim }): SearchTask {
    if (this.closed || !this.opts.enabled() || !this.opts.allowed(owner.subject)) return fail('disabled');
    if (input.protocol !== 1 || input.phase !== 'committed' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.turn)) return fail('invalid_request');
    if (!/^BJP003\d{14}$/.test(owner.subject) || !owner.session.startsWith(`sn-${owner.subject}-`)) return fail('invalid_request');
    if (this.db.prepare('SELECT 1 FROM closed_sessions WHERE subject=? AND session=?').get(owner.subject, owner.session)) return fail('session_closed');
    const query = validateQuery(input.query);
    const key = digest(JSON.stringify([owner.subject, owner.session, input.turn, query, input.replace ?? '', input.routing ?? null]));
    const prior = this.db.prepare('SELECT body FROM tasks WHERE dedupe=?').get(key) as { body: string } | undefined;
    if (prior) return JSON.parse(prior.body);
    const routing = input.routing ? this.opts.resolveRouting?.(owner, input.routing) ?? fail('routing_version_unknown') : undefined;
    if (this.opts.canSubmit && !this.opts.canSubmit(routing)) return fail('upstream_paused');
    this.tick();
    const all = this.all();
    // Bound paid work even after restarts; CST calendar day.
    const start = Math.floor((this.now() + 28_800_000) / 86_400_000) * 86_400_000 - 28_800_000;
    const today = all.filter(t => t.createdAt >= start);
    if (today.length >= (this.opts.dailyGlobalLimit ?? 1000) || today.filter(t => t.subject === owner.subject).length >= (this.opts.dailyDeviceLimit ?? 100)) return fail('daily_limit');
    const old = input.replace ? this.get(owner, input.replace) : undefined;
    const revision = old ? old.revision + 1 : 1;
    const outstanding = all.filter(t => LIVE.has(t.status) && !t.claim && t.id !== old?.id);
    const pendingAfterReplace = this.pending.size - (old && this.pending.has(old.id) ? 1 : 0);
    if (outstanding.filter(t => t.subject === owner.subject && t.session === owner.session).length >= 2 ||
        pendingAfterReplace >= (this.opts.queueLimit ?? 8)) return fail('queue_full');
    // Validate admission before cancelling an existing query. A rejected replacement keeps it intact.
    if (old) this.cancel(owner, old.id);
    const t: SearchTask = { ...owner, id: randomUUID(), key, turn: input.turn, revision, ...(routing ? {routing:structuredClone(routing)} : {}), status: 'queued', createdAt: this.now(), deadline: this.now() + 20_000 };
    this.save(t); this.pending.set(t.id, query); this.pump();
    return this.get(owner, t.id);
  }
  private pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      for (const [id, q] of this.pending) {
        if (this.active.size >= (this.opts.concurrency ?? 2)) break;
        const t = this.all().find(t => t.id === id)!;
        // At most one executing task per conversation; another room can use the other slot.
        if (this.all().some(x => x.session === t.session && x.subject === t.subject && this.active.has(x.id))) continue;
        this.pending.delete(id);
        if (t.status !== 'queued') continue;
        const controller = new AbortController();
        this.active.set(id, controller); t.status = 'running'; this.save(t);
        void this.run(t, q, controller);
      }
    } finally { this.pumping = false; }
  }
  private async run(t: SearchTask, q: string, controller: AbortController) {
    try {
      const result = await this.opts.execute(q, controller.signal, t);
      if (this.closed) return;
      this.tick();
      const current = this.get(t, t.id);
      if (current.status !== 'running' || controller.signal.aborted) return;
      if (!result.text.trim() || [...result.text].length > 150 || /\[\[|\]\]|https?:\/\//i.test(result.text) || result.sources.length > 3) throw new Error('invalid_result');
      current.result = result; current.diagnostics = result.diagnostics; current.status = 'ready'; current.readyAt = this.now(); this.save(current);
    } catch (e) {
      if (!this.closed) {
        const current = this.get(t, t.id);
        if (current.status === 'running') { current.status = 'failed'; current.error = e instanceof Error && /^upstream_(402|429|5\d\d)$/.test(e.message) ? e.message : 'search_unavailable'; current.readyAt = this.now(); this.save(current); }
      }
    } finally { this.active.delete(t.id); if (!this.closed) this.pump(); }
  }
  tick() {
    if (this.closed) return;
    const enabled = this.opts.enabled();
    const allowed = new Map<string, boolean>();
    for (const t of this.all()) {
      if (!LIVE.has(t.status) && t.status !== 'delivered') continue;
      if (!allowed.has(t.subject)) allowed.set(t.subject, this.opts.allowed(t.subject));
      if (!enabled || !allowed.get(t.subject)) { this.cancel(t, t.id); continue; }
      if ((t.status === 'queued' || t.status === 'running') && this.now() >= t.deadline ||
          t.readyAt !== undefined && this.now() >= t.readyAt + 300_000) {
        t.status = 'expired'; if (t.delivery === 'claimed') t.delivery = 'unknown'; delete t.result; this.save(t); this.pending.delete(t.id); this.active.get(t.id)?.abort();
      }
    }
    if (this.now() >= this.nextPurge) {
      const before = this.now() - 86_400_000;
      this.db.prepare('DELETE FROM tasks WHERE created<?').run(before);
      this.db.prepare('DELETE FROM closed_sessions WHERE created<?').run(before);
      for (const [id, t] of this.records) if (t.createdAt < before) this.records.delete(id);
      this.nextPurge = this.now() + 60_000;
    }
    this.pump();
  }
  list(owner: SearchOwner): SearchTask[] {
    this.tick();
    return this.all().filter(t => t.subject === owner.subject && t.session === owner.session &&
      (t.status === 'queued' || t.status === 'running' || (t.status === 'ready' || t.status === 'failed') &&
        (Boolean(t.claim) || this.now() - (t.readyAt ?? 0) < 60_000))).map(t => structuredClone(t));
  }
  cancel(owner: SearchOwner, id: string) {
    const t = this.get(owner, id);
    if (!LIVE.has(t.status) && t.status !== 'delivered') return t;
    t.status = 'cancelled'; delete t.result; this.save(t);
    this.pending.delete(id); this.active.get(id)?.abort();
    return t;
  }
  cancelSession(owner: SearchOwner) {
    this.db.prepare('INSERT OR IGNORE INTO closed_sessions VALUES(?,?,?)').run(owner.subject, owner.session, this.now());
    for (const t of this.all()) if (t.subject === owner.subject && t.session === owner.session) this.cancel(owner, t.id);
  }
  claim(owner: SearchOwner, id: string, delivery: string): SearchTask {
    this.tick();
    const t = this.get(owner, id);
    if (t.claim && t.claim !== delivery) return fail('already_claimed');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(delivery) || !['ready', 'failed'].includes(t.status) || this.now() - (t.readyAt ?? 0) >= 60_000) return fail('not_ready');
    t.claim = delivery; t.delivery = 'claimed'; this.save(t); return t;
  }
  resumable(owner: SearchOwner, id: string): SearchTask {
    if (this.closed || !this.opts.enabled() || !this.opts.allowed(owner.subject)) return fail('disabled');
    this.tick();
    const t = this.get(owner, id);
    if (t.status !== 'delivered' || !['completed', 'interrupted'].includes(t.delivery ?? '') || !t.result) return fail('not_ready');
    return t;
  }
  playback(owner: SearchOwner, id: string): SearchTask {
    if (this.closed || !this.opts.enabled() || !this.opts.allowed(owner.subject)) return fail('disabled');
    this.tick();
    const t = this.get(owner, id);
    if (!t.result || !t.claim || !['ready', 'delivered'].includes(t.status)) return fail('not_ready');
    return t;
  }
  replay(owner: SearchOwner, id: string, previous: string, delivery: string, automatic: boolean): SearchTask {
    const t = this.playback(owner, id);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(delivery) || delivery === previous) return fail('invalid_request');
    // A lost response may repeat the same attempt, but never spend another attempt.
    const attempts = t.replays ?? [];
    const prior = attempts.find(a => a.delivery === delivery);
    if (prior) {
      if (prior.previous === previous && prior.automatic === automatic && t.claim === delivery && t.delivery === 'claimed' &&
          (!automatic || this.now() < t.readyAt! + 60_000)) return t;
      return fail('not_ready');
    }
    if (t.claim !== previous) return fail('claim_mismatch');
    if (t.status !== 'delivered' || !['completed', 'interrupted'].includes(t.delivery ?? '') || attempts.length >= 8 ||
        automatic && (t.delivery !== 'interrupted' || attempts.some(a => a.automatic) || this.now() >= t.readyAt! + 60_000)) return fail('not_ready');
    t.replays = [...attempts, { previous, delivery, automatic, at: this.now() }];
    t.claim = delivery; t.delivery = 'claimed';
    this.save(t); return t;
  }
  receipt(owner: SearchOwner, id: string, delivery: string, outcome: 'completed' | 'interrupted' | 'dropped') {
    const t = this.get(owner, id);
    if (t.claim !== delivery) return fail('claim_mismatch');
    if (!['completed', 'interrupted', 'dropped'].includes(outcome)) return fail('invalid_request');
    if (t.delivery !== 'claimed') return t;
    t.delivery = outcome;
    if (t.status !== 'cancelled' && t.status !== 'expired') t.status = 'delivered';
    this.save(t); return t;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.active.values()) c.abort();
    this.pending.clear(); this.db.close();
  }
  audit() {
    return this.all().slice(-100).reverse().map(t => ({ id: t.id, device_suffix: t.subject.slice(-8), turn: t.turn,
      revision: t.revision, diagnostics: t.diagnostics, replays: t.replays?.length ?? 0, status: t.status, delivery: t.delivery ?? 'pending', error: t.error,
      created_at: t.createdAt, ready_at: t.readyAt, execution_ms: t.readyAt === undefined ? null : t.readyAt - t.createdAt,
      source_count: t.result?.sources.length ?? 0, sources: t.result?.sources.map(s => ({ url: s.url, date: s.date })) ?? [] }));
  }
}
