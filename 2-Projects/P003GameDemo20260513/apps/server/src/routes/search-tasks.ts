import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {weatherRequestSchema,autoWeatherSchema} from '../tools/moji-weather.js';
import {placeWeatherSchema} from '../tools/baidu-weather.js';
const routingClaim=z.object({version:z.string().regex(/^r7-[a-f0-9]{24}$/),rule_id:z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),weather:weatherRequestSchema.optional(),auto_weather:autoWeatherSchema.optional(),place_weather:placeWeatherSchema.optional()}).strict().refine(v=>[v.weather,v.auto_weather,v.place_weather].filter(Boolean).length<=1);
import type { SearchTasks, SearchOwner, SearchTask } from '../tools/search-tasks.js';

const submit = z.object({ protocol: z.literal(1), phase: z.literal('committed'), turn: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), query: z.string(), replace: z.string().uuid().optional(), routing:routingClaim.optional() }).strict();
const claim = z.object({ delivery: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }).strict();
const receipt = claim.extend({ outcome: z.enum(['completed', 'interrupted', 'dropped']) }).strict();
const replay = claim.extend({ previous: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), automatic: z.boolean() }).strict();
const view = (t: SearchTask) => ({ id: t.id, turn: t.turn, revision: t.revision, status: t.status,
  created_at: t.createdAt, deadline: t.deadline, ready_at: t.readyAt, result: t.result,
  delivery: t.delivery, error: t.error, routing_version:t.routing?.version, rule_id:t.routing?.rule_id,
  valid_for_ms: t.readyAt === undefined ? 0 : Math.max(0, t.readyAt + 300_000 - Date.now()),
  automatic_for_ms: t.readyAt === undefined ? 0 : Math.max(0, t.readyAt + 60_000 - Date.now()) });

export async function boundedSearchBody(c: Context) {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error('invalid_request');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > 8192) throw new Error('body_too_large'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createSearchRoute(deps: { owner: (c: Context) => Promise<SearchOwner | null>; tasks: () => SearchTasks | null; routing?: {get:(o:SearchOwner)=>unknown;ack:(o:SearchOwner,version:string)=>void} }) {
  const route = new Hono<{ Variables: { owner: SearchOwner; tasks: SearchTasks } }>();
  route.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const owner = await deps.owner(c);
    if (!owner) return c.json({ error: 'unauthorized' }, 401);
    const tasks = deps.tasks(); if (!tasks) return c.json({ error: 'disabled' }, 503);
    c.set('owner', owner); c.set('tasks', tasks); await next();
  });
  route.onError((err, c) => {
    const code = err instanceof z.ZodError || err instanceof SyntaxError ? 'invalid_request' : err.message;
    const statuses = { invalid_request: 400, private_query: 400, unsafe_query: 400, body_too_large: 413, disabled: 503,
      routing_version_unknown:409, routing_version_stale:409, routing_version_scope:403, upstream_paused: 503, not_found: 404, queue_full: 429, daily_limit: 429, session_closed: 409, already_claimed: 409, not_ready: 409, claim_mismatch: 409 } as const;
    const status = statuses[code as keyof typeof statuses];
    if (status === 429 || status === 503) c.header('Retry-After', '30');
    return c.json({ error: status ? code : 'search_unavailable' }, status ?? 503);
  });
  route.get('/routing', c=>c.json({protocol:1,snapshot:deps.routing?.get(c.get('owner'))??null}));
  route.post('/routing/ack',async c=>{const v=z.object({version:z.string().regex(/^r7-[a-f0-9]{24}$/)}).strict().parse(await boundedSearchBody(c));if(!deps.routing)throw new Error('disabled');deps.routing.ack(c.get('owner'),v.version);return c.json({ok:true});});
  route.get('/', c => c.json({ protocol: 1, tasks: c.get('tasks').list(c.get('owner')).map(view) }));
  route.post('/', async c => {
    const input = submit.parse(await boundedSearchBody(c));
    return c.json({ protocol: 1, task: view(c.get('tasks').submit(c.get('owner'), input)) }, 202);
  });
  route.post('/session/cancel', async c => {
    z.object({}).strict().parse(await boundedSearchBody(c));
    c.get('tasks').cancelSession(c.get('owner')); return c.json({ ok: true });
  });
  route.get('/:id', c => c.json({ task: view(c.get('tasks').resumable(c.get('owner'), c.req.param('id'))) }));
  route.get('/:id/playback', c => c.json({ task: view(c.get('tasks').playback(c.get('owner'), c.req.param('id'))) }));
  route.post('/:id/replay', async c => {
    const input = replay.parse(await boundedSearchBody(c));
    return c.json({ task: view(c.get('tasks').replay(c.get('owner'), c.req.param('id'), input.previous, input.delivery, input.automatic)) });
  });
  route.post('/:id/cancel', async c => {
    z.object({}).strict().parse(await boundedSearchBody(c));
    return c.json({ task: view(c.get('tasks').cancel(c.get('owner'), c.req.param('id'))) });
  });
  route.post('/:id/claim', async c => {
    const input = claim.parse(await boundedSearchBody(c));
    return c.json({ task: view(c.get('tasks').claim(c.get('owner'), c.req.param('id'), input.delivery)) });
  });
  route.post('/:id/receipt', async c => {
    const input = receipt.parse(await boundedSearchBody(c));
    return c.json({ task: view(c.get('tasks').receipt(c.get('owner'), c.req.param('id'), input.delivery, input.outcome)) });
  });
  return route;
}
