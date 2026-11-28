import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {z} from 'zod';
import {applyVoiceCues, defaultVoiceCues} from './voice-progress.js';

const dayMs = 86400000;
const utc8 = 8 * 3600000;
const phrase = z.string().trim().min(6).max(40).regex(/^[^\p{Cc}<>。！？!?]+[。！？!?]$/u);
const cuesSchema = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  chat: z.array(phrase).max(12), search: z.array(phrase).max(12),
  chatWaitMs: z.number().int().min(100).max(3000), searchWaitMs: z.number().int().min(100).max(3000),
}).strict();

function page(offset = '0', limit = '25') {
  if (!/^\d{1,8}$/.test(offset) || !/^\d{1,2}$/.test(limit) || +limit < 1 || +limit > 50) return null;
  return {offset: +offset, limit: +limit};
}

function groupDays(db: DatabaseSync, table: 'conversation'|'growth_event'|'extraction_log', owner: string, start: number) {
  const role = table === 'conversation' ? " AND role='user'" : '';
  const rows = db.prepare(`SELECT date(ts / 1000, 'unixepoch', '+8 hours') day, count(*) n
    FROM ${table} WHERE account_id=? AND ts>=? AND ts<?${role} GROUP BY day`).all(owner, start, start + 7 * dayMs);
  return new Map(rows.map(r => [String(r.day), Number(r.n)]));
}

export function createConsoleActivity(dataDir: string, owner: string, redact: (text:string) => string) {
  const profile = new DatabaseSync(join(dataDir, 'profile.sqlite'));
  const chats = new DatabaseSync(join(dataDir, 'conversations.sqlite'), {readOnly:true});
  profile.exec('CREATE TABLE IF NOT EXISTS personal_voice_cues (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings TEXT NOT NULL)');
  const readCues = () => {
    const row = profile.prepare('SELECT settings FROM personal_voice_cues WHERE owner=?').get(owner);
    return row ? cuesSchema.parse(JSON.parse(String(row.settings))) : defaultVoiceCues;
  };
  applyVoiceCues(readCues());
  const app = new Hono();
  app.get('/voice-cues', c => c.json(readCues()));
  app.put('/voice-cues', async c => {
    const parsed = cuesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error:'请核对等待时间和短语长度，每句以句号、问号或感叹号结尾。'},400);
    const next = {...parsed.data, revision:parsed.data.revision + 1};
    const saved = profile.prepare(`INSERT INTO personal_voice_cues(owner,revision,settings)
      SELECT ?,?,? WHERE ?=COALESCE((SELECT revision FROM personal_voice_cues WHERE owner=?),0)
      ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision, settings=excluded.settings`)
      .run(owner,next.revision,JSON.stringify(next),parsed.data.revision,owner);
    if (!saved.changes) return c.json({error:'衔接语已在别处修改，请刷新后再保存。'},409);
    applyVoiceCues(next);
    return c.json(next);
  });
  app.get('/activity', c => {
    const paging = page(c.req.query('offset'), c.req.query('limit'));
    if (!paging) return c.json({error:'分页参数无效'},400);
    const start = Math.floor((Date.now()+utc8)/dayMs)*dayMs - utc8 - 6*dayMs;
    const turns = groupDays(chats,'conversation',owner,start);
    const growth = groupDays(profile,'growth_event',owner,start);
    const extracted = groupDays(profile,'extraction_log',owner,start);
    const days = Array.from({length:7}, (_,i) => {
      const date = new Date(start + utc8 + i*dayMs).toISOString().slice(0,10);
      return {date, turns:turns.get(date) ?? 0, growth:growth.get(date) ?? 0, extractions:extracted.get(date) ?? 0};
    });
    const last = profile.prepare('SELECT ts,ok FROM extraction_log WHERE account_id=? ORDER BY ts DESC,rowid DESC LIMIT 1').get(owner);
    const total = chats.prepare('SELECT count(DISTINCT session_id) n FROM conversation WHERE account_id=?').get(owner)!.n;
    const items = chats.prepare(`SELECT session_id AS session,min(ts) AS firstAt,max(ts) AS lastAt,count(*) AS messages
        FROM conversation WHERE account_id=? GROUP BY session_id ORDER BY lastAt DESC,session_id LIMIT ? OFFSET ?`)
      .all(owner,paging.limit,paging.offset);
    return c.json({days,extraction:{available:true,lastAt:last?.ts ?? null,lastStatus:last ? (last.ok ? 'ok' : 'failed') : null},
      total:Number(total),items});
  });
  app.get('/conversations/:session', c => {
    const id = c.req.param('session'), paging = page(c.req.query('offset'), c.req.query('limit'));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !paging) return c.json({error:'会话或分页参数无效'},400);
    const total = Number(chats.prepare('SELECT count(*) n FROM conversation WHERE account_id=? AND session_id=?').get(owner,id)!.n);
    if (!total) return c.json({error:'未找到该通话记录'},404);
    const anchor=c.req.query('anchor');let offset=paging.offset;
    if(anchor!==undefined) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(anchor)) return c.json({error:'消息标识无效'},400);
      const message=chats.prepare('SELECT ts,rowid AS seq FROM conversation WHERE account_id=? AND session_id=? AND id=?').get(owner,id,anchor);
      if(!message) return c.json({error:'当前通话中没有这条消息'},404);
      const preceding=chats.prepare('SELECT count(*) n FROM conversation WHERE account_id=? AND session_id=? AND (ts<? OR (ts=? AND rowid<?))')
        .get(owner,id,message.ts,message.ts,message.seq)!;
      offset=Math.floor(Number(preceding.n)/paging.limit)*paging.limit;
    }
    const items = chats.prepare(`SELECT id,role,text,ts AS at FROM conversation WHERE account_id=? AND session_id=?
        ORDER BY ts,rowid LIMIT ? OFFSET ?`).all(owner,id,paging.limit,offset);
    return c.json({total,offset,items:items.map(item=>({...item,text:redact(String(item.text))}))});
  });
  return app;
}
