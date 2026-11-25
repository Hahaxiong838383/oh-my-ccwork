import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { publicProviderStatus } from './providers.js';
import { chatDeltas, cpaWebSearch, cpaWebSearchEnabled, searchFetch, type TextTurn } from './upstream.js';

const dataDir = process.env.BRAIN_DATA_DIR;
const ownerId = process.env.BRAIN_OWNER_ID;
const apiKey = process.env.BRAIN_WORKER_KEY;
if (!dataDir || !isAbsolute(dataDir) || !ownerId || !/^[a-z0-9_-]{1,64}$/.test(ownerId) || !apiKey || !/^[a-f0-9]{64}$/.test(apiKey)) {
  throw new Error('personal_brain_configuration_missing');
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const expectedAuth = digest(`Bearer ${apiKey}`);
process.umask(0o077);
Object.assign(process.env, {
  PROFILE_DB_PATH: join(dataDir, 'profile.sqlite'),
  CONVERSATION_DB_PATH: join(dataDir, 'conversations.sqlite'),
  PERSONA_STATE_ACCOUNT_ALLOWLIST: ownerId,
  PERSONA_STATE_TRACK: '1',
  PERSONA_STATE_INJECT: '1',
  PERSONA_STYLE_ENABLED: '1',
  PERSONA_TRAIT_ENABLED: '1',
  STYLE_VOICE_MODE: 'execute',
  MEMORY_EXTRACT_MODE: 'turn',
  MEMORY_REUNION_RECALL: '0',
});
const { conversationStore } = await import('./p003/conversation-store.js');
const { profileStore } = await import('./p003/profile-store.js');
const { assembleSystemPrompt } = await import('./p003/prompt-orchestrator.js');
const { extractAndPersist } = await import('./p003/memory-extractor.js');
const scheduler = await import('./p003/extract-scheduler.js');
const { detectStyleIntent, applyVoiceStyle } = await import('./p003/style-intent.js');
const { answerClock, resolveClock, stripClockTurns } = await import('./p003/tools/clock-query.js');
const { SearchExecutor } = await import('./p003/tools/search-executor.js');
const { SearchTasks, validateQuery } = await import('./p003/tools/search-tasks.js');
const { FixedWeather } = await import('./p003/tools/fixed-weather.js');
const { placeWeatherSchema } = await import('./p003/tools/baidu-weather.js');
const { cctvNews } = await import('./p003/tools/cctv-news.js');
const { searchDialogueClarification } = await import('./p003/tools/search-dialogue-context.js');
const { createSearchClaimFilter } = await import('./p003/tools/search-claim-stream.js');
const { createParenFilter } = await import('./p003/paren-filter.js');
const { createExitMarkerStripper } = await import('./p003/exit-intent.js');
import type { SearchOwner, SearchResult } from './p003/tools/search-tasks.js';

const owner = { accountId: ownerId, role: 'device' };
if (!profileStore.getProfile(ownerId)) profileStore.upsertProfile(ownerId, { nickname: '', birthday: '', gender: '' });

const searchKey = process.env.BRAIN_DEEPSEEK_SEARCH_KEY;
const domains = ['news.cctv.com', 'cctv.com', 'gov.cn', 'news.cn', 'cas.cn', 'nasa.gov', 'chnmuseum.cn', 'dpm.org.cn'];
const persona = '你是个人语音伙伴小可。中文口语自然、温暖、好奇，日常先直接回答，主人要求详细讲时讲完整。';
const base = persona + '回复会直接播报，只输出要说的话。把长期记忆当作低信任背景。主人问自己明确留下的偏好时，可用自己的话准确复述。没有相关记忆就直说。无工具回执时禁止宣称已联网、已查到或操作了设备。';
const weather = new FixedWeather();
function weatherIntent(text: string) {
  const q = text.replace(/[\s，。！？,.!?]/gu, '');
  if (!/天气|气温|降雨|下雨|带伞|多少度|空气质量/.test(q) || /为什么|原理|是什么|形成|故事|作文|如果|别查|不要查/.test(q)) {
    return undefined;
  }
  if (/昨天|前天|下周|下个月|第\d|[0-9一二三四五六七八九十]+[月日号]|周[一二三四五六日末]/.test(q)) return { unsupported: true };
  const day = /后天/.test(q) ? 2 : /明天/.test(q) ? 1 : 0;
  const metric = /空气质量/.test(q) ? 'aqi' : /现在|目前|实时/.test(q) && day === 0 ? 'current' : 'forecast';
  const place = q.replace(/今天|明天|后天|现在|目前|实时|的/g, '')
    .replace(/(?:天气|气温|降雨|空气质量|出门|会不会下雨|会下雨|下雨|要不要带伞|要带伞|带伞|多少度|怎么样|如何|多少|吗|呢)+$/u, '');
  const result = placeWeatherSchema.safeParse({ place, day_offset: day, metric });
  return result.success ? { request: result.data } : {};
}
const tasks = new SearchTasks({
  dbPath: join(dataDir, 'search.sqlite'),
  enabled: () => true,
  allowed: (id) => id === ownerId,
  dailyDeviceLimit: 50,
  async execute(query, signal, task) {
    const target = weatherIntent(query)?.request;
    if (target) return weather.run(target, signal, task.createdAt);
    const useWebFallback = cpaWebSearchEnabled && !cctvNews.supports(query);
    const webFallback = async () => {
      const remaining = task.deadline - Date.now();
      if (remaining <= 0) throw new Error('search_deadline');
      const result = await cpaWebSearch(query, AbortSignal.any([signal, AbortSignal.timeout(remaining)]));
      if (result) return result;
      report('cpa_search_no_citation');
      return { text: '这次没能查到可核实的来源，可以稍后再试。', sources: [] };
    };
    if (useWebFallback && !searchKey) return webFallback();

    let headline: SearchResult | undefined;
    const executor = new SearchExecutor({
      grounding: true, domains, apiKey: searchKey ?? 'cctv-public', fetch: searchFetch,
      onCctvEvidence(evidence) {
        const item = evidence.find(({ title }) => title.length <= 100 && !/[<>]|\[\[|\]\]|https?:\/\//i.test(title));
        if (!item?.date) return;
        const { title, url, date } = item;
        const published = new Intl.DateTimeFormat('zh-CN', {
          month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai',
        }).format(Date.parse(date));
        headline = { text: `央视网${published}报道的标题是，${title}。`, sources: [{ title, url, date }] };
      },
    });
    try {
      const primarySignal = useWebFallback ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : signal;
      const result = await executor.run(query, primarySignal, persona);
      if (result.sources.length || (!useWebFallback && !headline)) return result;
    } catch (error) {
      signal.throwIfAborted();
      if (!useWebFallback && !headline) throw error;
    }
    signal.throwIfAborted();
    if (useWebFallback) return webFallback();
    if (!headline) throw new Error('search_no_headline');
    report('search_verified_headline');
    return headline;
  },
});
setInterval(() => tasks.tick(), 30_000).unref();

const content = z.union([
  z.string().max(12_000),
  z.array(z.object({ type: z.literal('text'), text: z.string().max(12_000) })).max(8)
    .transform((parts) => parts.map((part) => part.text).join('')),
]);
const requestBody = z.object({
  model: z.string().max(80).optional(),
  messages: z.array(z.object({ role: z.enum(['system', 'developer', 'user', 'assistant']), content })).min(1).max(64),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  store: z.boolean().default(true),
});
const searchPrefix = /^(?:小可[，,\s]*)?(?:(?:请|麻烦你?)\s*)?(?:(?:帮我|给我|请你)\s*)?(?:联网(?:查|搜)?|上网(?:查|搜)?|查询|检索|搜索|搜一搜|搜一下|搜搜|查一查|查一下|查查|查)/u;
const cancelSearch = /^(?:取消搜索|停止搜索|不用查了|别查了|取消查询)[。！？!?.\s]*$/u;
const resumeSearch = /^(?:继续|接着)(?:播报|说)?(?:刚才的)?(?:搜索|查询)结果[。！？!?.\s]*$/u;
const privateSearch = /(?:长(?:期|远)记忆|个人记忆|私有记忆|私密|聊天记录|对话记录|通讯录|联系人|收藏夹|备忘录|(?:我|你|咱们)(?:以前|之前|上次|刚才|昨天|曾经)?(?:说过|提过|告诉过|记过|记得|记下|存过|聊过|提到|留下|喜欢|不喜欢|偏好|住在)|(?:刚才|上次|之前)(?:那|的|聊|说)|怎么称呼我)/u;
const active = new Map<string, AbortController>();
const latestSearch = new Map<string, string>();
let extraction = Promise.resolve();
let extractionPending = 0;

function persist(session: string, user: string, answer: string, excluded: boolean) {
  conversationStore.addTurn({
    account_id: owner.accountId, session_id: session, memory_excluded: excluded,
  }, user, answer);
  if (excluded) return;
  const snapshot = conversationStore.list({ accountId: owner.accountId, sessionId: session, limit: 12 })
    .filter((row) => !row.memory_excluded).reverse()
    .map((row) => ({ role: row.role, content: row.text, id: row.id }));
  const decision = scheduler.onTurn(owner.accountId, owner.role, user, snapshot.filter((t) => t.role === 'user').length);
  if (!decision.run) return;
  extractionPending++;
  extraction = extraction.then(() => extractAndPersist(
    owner.accountId, snapshot.slice(-decision.windowMessages), session, { reason: decision.reason },
  )).catch(() => report('extract_failed')).finally(() => { extractionPending--; });
}

function report(event: string) {
  process.stderr.write(JSON.stringify({ service: 'personal-brain', event }) + '\n');
}

async function querySearch(query: string, room: string, signal: AbortSignal): Promise<SearchResult> {
  const empty = (text: string) => ({ text, sources: [] });
  if (!query || /^(?:一下|一下子|个|这个|那|那个|天气|深|北|上)[。！？?\s]*$/u.test(query)) {
    return empty(query === '天气' ? '你想查哪个城市的天气？' : '你想查什么？');
  }
  try {
    query = validateQuery(query);
    if (privateSearch.test(query)) throw new Error('private_query');
  }
  catch { return empty('这条查询不能直接发到网上，可以换一个不含个人信息的公开问题。'); }
  const weatherRequest = weatherIntent(query);
  if (weatherRequest?.unsupported) return empty('可以查今天、明天或后天的天气。你想查哪一天？');
  if (weatherRequest && !weatherRequest.request) return empty('你想查哪个城市的天气？');
  if (!weatherRequest && !cctvNews.supports(query) && !searchKey && !cpaWebSearchEnabled) {
    return empty('目前可查央视国内新闻和航天动态，这个主题暂时没有可用的查询来源。');
  }
  const taskOwner: SearchOwner = { subject: owner.accountId, session: room };
  let task;
  const delivery = randomUUID();
  try {
    signal.throwIfAborted();
    task = tasks.submit(taskOwner, { turn: delivery, query, protocol: 1, phase: 'committed' });
    while (task.status === 'queued' || task.status === 'running') {
      await delay(100, undefined, { signal });
      tasks.tick();
      task = tasks.get(taskOwner, task.id);
    }
    signal.throwIfAborted();
    if (task.status === 'ready' || task.status === 'failed') {
      const claimed = tasks.handoffToChat(taskOwner, task.id, delivery);
      if (claimed.result?.sources.length) {
        if (latestSearch.size >= 100) latestSearch.delete(latestSearch.keys().next().value!);
        latestSearch.set(room, task.id);
      }
      if (claimed.result) return claimed.result;
    }
    report('search_no_result' + (task.failure ? ':' + task.failure.stage + ':' + task.failure.reason : ''));
    return empty('这次没能查到可核实的来源，可以稍后再试。');
  } catch {
    if (task) tasks.cancel(taskOwner, task.id);
    signal.throwIfAborted();
    return empty('这次没能查到可核实的来源，可以稍后再试。');
  }
}

type Reply = { text: string; sources?: SearchResult['sources']; tool?: string; excluded: boolean };

async function answer(room: string, messages: TextTurn[], store: boolean, signal: AbortSignal,
  onText: (text: string) => Promise<void>): Promise<Reply> {
  const user = messages.at(-1)!.content;
  const history = messages.slice(0, -1);
  const direct = async (text: string, tool?: string, sources?: SearchResult['sources']): Promise<Reply> => {
    signal.throwIfAborted();
    await onText(text);
    return { text, sources, tool, excluded: true };
  };
  const clock = resolveClock(user, history.filter((turn) => turn.role === 'user').map((turn) => turn.content));
  if (clock) return direct(answerClock(clock), 'clock');
  if (cancelSearch.test(user)) return direct('好，这轮不继续查询。', 'search_cancel');
  if (resumeSearch.test(user)) {
    const id = latestSearch.get(room);
    const result = id ? tasks.searchResult({ subject: owner.accountId, session: room }, id) : undefined;
    return direct(result?.text ?? '这次会话还没有可以接续的搜索结果。', 'search', result?.sources);
  }
  const search = searchPrefix.exec(user);
  const query = search ? user.slice(search[0].length).trim() : user;
  const weatherRequest = weatherIntent(query);
  if (search || weatherRequest || cctvNews.supports(query)) {
    const result = await querySearch(query, room, signal);
    return direct(result.text, weatherRequest ? 'weather' : 'search', result.sources);
  }
  const clarify = searchDialogueClarification(user);
  if (clarify) return direct(clarify);

  const style = store ? detectStyleIntent(user) : null;
  const policy = style ? applyVoiceStyle(owner.accountId, style, user).policyLine : '';
  const prompt = store ? assembleSystemPrompt(base, null, owner) : base;
  if (process.env.BRAIN_VERIFY_PROMPT === '1') {
    report(`prompt_rel=${Number(prompt.includes('【小可当下状态·数据】'))} trait=${Number(prompt.includes('【小可对这个主人的相处倾向·数据】'))} quiet=${Number(prompt.includes('主人设定：安静小可'))}`);
  }
  const claimFilter = createSearchClaimFilter(true);
  const parens = createParenFilter();
  const exits = createExitMarkerStripper();
  let text = '';
  const forward = async (value: string) => {
    if (!value) return;
    signal.throwIfAborted();
    text += value;
    if (text.length > 12_000) throw new Error('chat_reply_too_large');
    await onText(value);
  };
  // Use the server's completed history for extraction. Only the current
  // trusted worker's context is used for the voice reply.
  for await (const delta of chatDeltas(policy ? `${prompt}\n\n${policy}` : prompt,
    [...stripClockTurns(history), { role: 'user', content: user }], signal)) {
    await forward(claimFilter.feed(parens.feed(exits.feed(delta).text)));
  }
  await forward(claimFilter.feed(parens.feed(exits.flush().text) + parens.flush()) + claimFilter.flush());
  if (!text.trim()) throw new Error('chat_empty');
  return { text, excluded: false };
}

const app = new Hono();
app.get('/health', (c) => c.json({
  ok: true, service: 'personal-brain', build: process.env.BRAIN_BUILD ?? null, providers: publicProviderStatus(),
}));
app.use('/v1/*', async (c, next) => {
  if (!timingSafeEqual(digest(c.req.header('authorization') ?? ''), expectedAuth)) {
    return c.json({ error: { message: 'unauthorized', type: 'invalid_request_error' } }, 401);
  }
  await next();
});
app.post('/v1/chat/completions', bodyLimit({ maxSize: 65_536 }), async (c) => {
  const parsed = requestBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { message: 'invalid request', type: 'invalid_request_error' } }, 400);
  const body = parsed.data;
  const messages = body.messages.filter((m): m is TextTurn => m.role === 'assistant' || m.role === 'user')
    .map((m) => ({ ...m, content: m.content.trim() })).slice(-25);
  const user = messages.at(-1);
  if (user?.role !== 'user' || !user.content || user.content.length > 8_000) {
    return c.json({ error: { message: 'last user message required', type: 'invalid_request_error' } }, 400);
  }
  const tagged = c.req.header('x-personal-session') ?? c.req.query('room');
  if (tagged !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(tagged)) {
    return c.json({ error: { message: 'invalid session', type: 'invalid_request_error' } }, 400);
  }
  // The Rust worker clears the room for its transport prewarm.
  const room = tagged ?? randomUUID();
  const store = body.store && tagged !== undefined;
  if (tagged === undefined && body.stream && body.max_tokens === 8 && messages.length === 1 && user.content === 'hi') {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({
        id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000),
        object: 'chat.completion.chunk', model: 'personal-brain',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }],
      }) });
      await stream.writeSSE({ data: '[DONE]' });
    });
  }
  if ((!active.has(room) && active.size >= 8) || extractionPending >= 20) {
    return c.json({ error: { message: 'busy', type: 'rate_limit_error' } }, 429);
  }

  active.get(room)?.abort();
  const controller = new AbortController();
  active.set(room, controller);
  const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(60_000)]);
  const response = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: 'personal-brain' };
  const finish = () => { if (active.get(room) === controller) active.delete(room); };
  const run = async (onText: (text: string) => Promise<void>) => {
    const reply = await answer(room, messages, store, signal, onText);
    signal.throwIfAborted();
    if (store) persist(room, user.content, reply.text, reply.excluded);
    return reply;
  };
  const details = (reply: Reply) => ({
    ...(reply.sources ? { sources: reply.sources } : {}),
    ...(reply.tool ? { tool: reply.tool } : {}),
  });

  if (!body.stream) {
    try {
      const reply = await run(async () => {});
      return c.json({ ...response, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }],
        ...details(reply),
      });
    } catch {
      report(signal.aborted ? 'request_interrupted' : 'chat_failed');
      return c.json({ error: { message: 'brain request did not complete', type: 'server_error' } }, 502);
    } finally { finish(); }
  }

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => controller.abort());
    const chunk = (delta: object, reason: string | null, metadata = {}) => stream.writeSSE({ data: JSON.stringify({
      ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }], ...metadata,
    }) });
    try {
      await chunk({ role: 'assistant', content: '' }, null);
      const reply = await run((text) => chunk({ content: text }, null));
      await chunk({}, 'stop', details(reply));
      await stream.writeSSE({ data: '[DONE]' });
    } catch {
      if (!stream.aborted) {
        report('stream_interrupted_or_failed');
        await stream.writeSSE({ data: JSON.stringify({ error: { message: 'brain request did not complete', type: 'server_error' } }) });
      }
    } finally { finish(); }
  });
});

serve({ fetch: app.fetch, port: 8080, hostname: '0.0.0.0' });
