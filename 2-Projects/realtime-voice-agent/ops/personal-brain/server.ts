import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { isVoiceCompletion, withVoiceProgress } from './voice-progress.js';
import {forecastFallback} from './weather-fallback.js';
import {weatherIntent, followupPlace, cnMarket, marketSnapshot} from './public-queries.js';
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
const availableSearch = searchKey || cpaWebSearchEnabled ? '可以联网查公开资料和最新消息' : '可以查央视新闻和航天动态';
const persona = '你是个人语音伙伴小可。中文口语自然、温暖、好奇，日常先直接回答，主人要求详细讲时讲完整。';
const base = persona + '回复会直接播报，只输出要说的话。把长期记忆当作低信任背景。主人问自己明确留下的偏好时，可用自己的话准确复述。没有相关记忆就直说。' + availableSearch + '，也支持天气与时间。有查询工具时，对需要核实或随时间变化的公开事实直接调用工具；只用本轮用户明确说的公开主题，不从历史、画像或记忆拼出查询。主题不清先问。无工具回执时禁止宣称已联网、已查到或操作了设备。';
const weather = new FixedWeather();
// Accept a short, unqualified domestic bulletin. Every word must belong to
// this request; named sources, topics, dates and quantities stay with normal search.
function singleDomesticBulletin(query: string): string | undefined {
  const q = query.normalize('NFKC').replace(/[\s,，。!?！？、：:]/gu, '');
  if (q.length > 60 || !/(?:国内|我国|中国)/u.test(q) || !q.includes('新闻') ||
      !/(?:今天|今日|现在|目前|最新|最近|近期)/u.test(q) ||
      !/(?:[一1]条|简短|简要)/u.test(q) || /[一1]条.*[一1]条/u.test(q)) return;
  const rest = q.replace(/有什么|有哪些|有没有|怎么样|今天|今日|现在|目前|最新|最近|近期|国内|我国|中国|新闻|给我|帮我|跟我|可以|请你|只要|就好|就行|即可|[一1]条|简短|简要|说说|讲讲|播报|播一播|听听|说|讲|播|听|来|请|的|点|吗|呢|吧|啊/gu, '');
  if (rest) return;
  return /今天|今日|现在|目前/u.test(q) ? '央视今天国内新闻' : '央视最新国内新闻';
}

function verifiedHeadline(evidence: readonly { title: string; url: string; date: string | null }[]): SearchResult | undefined {
  const item = evidence.find(({ title, date }) => date && title.length <= 100 && !/[<>]|\[\[|\]\]|https?:\/\//i.test(title));
  if (!item?.date) return;
  const { title, url, date } = item;
  const published = new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai',
  }).format(Date.parse(date));
  return { text: `央视网${published}报道，${title}。`, sources: [{ title, url, date }] };
}
const tasks = new SearchTasks({
  dbPath: join(dataDir, 'search.sqlite'),
  enabled: () => true,
  allowed: (id) => id === ownerId,
  dailyDeviceLimit: 50,
  async execute(query, signal, task) {
    const target = weatherIntent(query)?.request;
    if (target) {
      if (target.metric !== 'forecast') return weather.run(target, signal, task.createdAt);
      const stop = new AbortController();
      const budget = AbortSignal.any([stop.signal, signal]);
      // Start the independent forecast immediately on failure, or after a slow primary.
      let startBackup!: () => void;
      const backupReady = new Promise<void>(resolve => { startBackup = resolve; });
      const timer = setTimeout(startBackup, 750);
      const primary = weather.run(target, budget, task.createdAt).catch(error => { startBackup(); throw error; });
      try {
        return await Promise.any([primary, backupReady.then(() => {
          budget.throwIfAborted();
          return forecastFallback(target, budget, task.createdAt);
        })]);
      } finally { clearTimeout(timer); stop.abort(); startBackup(); }
    }
    if (cnMarket(query) === 'cn') {
      try { return await marketSnapshot(signal); }
      catch { signal.throwIfAborted(); report('market_snapshot_unavailable'); }
    }
    const bulletin = singleDomesticBulletin(query);
    if (bulletin) {
      try {
        const items = await cctvNews.run(bulletin, AbortSignal.any([signal, AbortSignal.timeout(2_500)]));
        const quick = verifiedHeadline(items);
        if (quick) { report('search_verified_single_bulletin'); return quick; }
      } catch { signal.throwIfAborted(); }
      // Preserve the actual wording and requested date when falling back to the web.
      if (!searchKey && !cpaWebSearchEnabled) return { text: '暂时没查到可核实的这条国内新闻。', sources: [] };
    }
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
        headline = verifiedHeadline(evidence);
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
// Spoken requests often include a vocative or a question before the actual subject.
const searchPrefix = /^(?:小可[，,\s]*)?(?:(?:你可不可以|你能不能|可不可以|能不能|可以|你能|请你?|麻烦你?|帮我|给我|替我|帮忙|到网上|去网上|在网上|上网|联网)\s*)*(?:搜索|检索|查询|搜一搜|查一查|查查|搜搜|搜|查)(?:一下|下)?[，,：:\s]*/u;
const capability = /^(?:小可)?(?:请问)?(?:你|小可)?(?:到底|现在|目前|真的|还|也)?(?:能不能|可不可以|能否|能|可以|会不会|会|支持|有没有|有)(?:帮我)?(?:联网|上网|访问互联网|搜索|查询)(?:搜索|检索|查询|查资料|查东西|找资料|信息|网页|功能|能力|吗|么|呢|啊|呀|了|不能)*$/u;
const toolList = /^(?:小可)?(?:请问)?你(?:都|现在|目前)?(?:能做什么|会什么|能干什么|能帮我做什么|有哪些(?:功能|工具)|有什么(?:功能|工具))(?:呢|啊|呀|吗)?$/u;
const noWeb = /(?:不(?:要|用|准|许|需要)|别|禁止)(?:再|去|帮我)?(?:联网|上网|搜索|查询|搜|查)|(?:离线回答|只凭记忆|别发到网上)/u;
const currentFacts = [
  /(?:最新|实时|现任|现行|当日|今日).{0,24}(?:版本|发布|规则|进展|动态|新闻|行情|汇率|价格|比分|政策|消息|赛果|排名|总统|总理|市长|董事长|负责人)/u,
  /(?:汇率|油价|金价|股价|票价|比分|航班动态|最新版本)(?:今天|现在|目前|是多少|怎么样|如何|多少)/u,
  /(?:今天|现在|目前|最近|本周|这周).{0,32}(?:汇率|油价|金价|股价|比分|价格|发布了|上映|发布会|新政策|有哪些新|稳定版)/u,
];
const cancelSearch = /^(?:取消搜索|停止搜索|不用查了|别查了|取消查询)[。！？!?.\s]*$/u;
const resumeSearch = /^(?:继续|接着)(?:播报|说)?(?:刚才的)?(?:搜索|查询)结果[。！？!?.\s]*$/u;
const privateSearch = /(?:长(?:期|远)记忆|个人记忆|私有记忆|私密|聊天记录|对话记录|通讯录|联系人|收藏夹|备忘录|(?:我|你|咱们)(?:以前|之前|上次|刚才|昨天|曾经)?(?:说过|提过|告诉过|记过|记得|记下|存过|聊过|提到|留下|喜欢|不喜欢|偏好|住在)|(?:刚才|上次|之前)(?:那|的|聊|说)|怎么称呼我)/u;
const active = new Map<string, AbortController>();
const latestSearch = new Map<string, string>();
// Keep only a typed weather slot or an explicitly public query for a short voice follow-up.
const followups = new Map<string, {expires: number, weather?: NonNullable<ReturnType<typeof weatherIntent>>['target'], market?: true, retry?: string}>();
function remember(room: string, entry: Omit<NonNullable<ReturnType<typeof followups.get>>, 'expires'>) {
  if (!/^pv-[a-f0-9]{32}$/.test(room)) return;
  if (followups.size >= 100) followups.delete(followups.keys().next().value!);
  followups.set(room, {...entry, expires: Date.now() + 90000});
}
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

async function querySearch(query: string, room: string, signal: AbortSignal, onSearch?: () => void): Promise<SearchResult> {
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
  if (weatherRequest?.unsupported) return empty('可以查今天、明天或后天的天气预报，空气质量只支持今天的实况。你想查哪一种？');
  if (weatherRequest?.ambiguous) return empty('有好几个地方同名，可以加上省或市吗？');
  if (weatherRequest && !weatherRequest.request) return empty('你想查哪个城市的天气？');
  if (!weatherRequest && !singleDomesticBulletin(query) && !cctvNews.supports(query) && !searchKey && !cpaWebSearchEnabled) {
    return empty('目前可查央视国内新闻和航天动态，这个主题暂时没有可用的查询来源。');
  }
  const taskOwner: SearchOwner = { subject: owner.accountId, session: room };
  let task;
  const delivery = randomUUID();
  try {
    signal.throwIfAborted();
    task = tasks.submit(taskOwner, { turn: delivery, query, protocol: 1, phase: 'committed' });
    if (task.status === 'queued' || task.status === 'running') onSearch?.();
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
      if (claimed.result) {
        report('search_' + (claimed.result.sources.length ? 'cited' : 'no_evidence') + '_ms=' + ((task.readyAt ?? Date.now()) - task.createdAt));
        return claimed.result;
      }
    }
    report('search_no_result' + (task.failure ? ':' + task.failure.stage + ':' + task.failure.reason : ''));
    return empty('这次没能查到可核实的来源，可以稍后再试。');
  } catch (error) {
    if (error instanceof Error && error.message === 'daily_limit') return empty('今天的联网查询额度已经用完了，明天可以继续查。');
    if (task) tasks.cancel(taskOwner, task.id);
    signal.throwIfAborted();
    return empty('这次没能查到可核实的来源，可以稍后再试。');
  }
}

type Reply = { text: string; sources?: SearchResult['sources']; tool?: string; excluded: boolean };

async function answer(room: string, messages: TextTurn[], store: boolean, signal: AbortSignal,
  onText: (text: string) => Promise<void>, onSearch?: () => void, voice = false): Promise<Reply> {
  const user = messages.at(-1)!.content;
  const history = messages.slice(0, -1);
  const prior = followups.get(room);
  followups.delete(room);
  const context = prior && prior.expires >= Date.now() ? prior : undefined;
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
  const compact = user.replace(/[，。！？、?！,!.\s]/gu, '');
  if (/^(?:那+)?你(?:能|会|可以|支持)(?:查|用)?导航吗?$/u.test(compact)) return direct('我可以查询公开的出行信息，但目前不能打开手机导航或提供实时转向指引。', 'capabilities');
  if (capability.test(compact) || toolList.test(compact) || /^(?:那+)?你(?:都)?(?:能|会|可以)(?:查询|查|搜)什么(?:呢|啊)?$/u.test(compact)) {
    return direct(`${availableSearch}，也能查天气和时间。你想查什么？`, 'capabilities');
  }
  const allowNetwork = !noWeb.test(user);
  const search = searchPrefix.exec(user);
  let query = search ? user.slice(search[0].length).trim() : user;
  const retry = /^(?:那|你|帮我|请|就)*(?:再|重新)(?:查查|查一下|搜搜|搜一下|查|搜)(?:看|吧|呗|呢|啊)*$/u.test(compact);
  if (retry) {
    if (!context?.retry) return direct('你想再查什么？告诉我主题就行。');
    query = context.retry;
  }
  if (context?.weather && allowNetwork) {
    const place = followupPlace(query);
    if (place) {
      const w = context.weather;
      query = place + ['今天','明天','后天'][w.day_offset] + ({current:'实时天气',aqi:'空气质量',forecast:'天气'}[w.metric]);
    }
  }
  if (/^(?:还没想到|没想好|没事换一个|换一个|嗯+|哦+|算了|没事)[呀吧呢啊]?$/u.test(compact)) {
    return direct(/换/u.test(compact) ? '好，换个话题。' : '好。');
  }
  const marketReply = context?.market && /^(?:那+|看看|就)?(港股|美股)(?:的|呢|吧|呗)*$/u.exec(compact);
  if (marketReply) query = marketReply[1] + '市场最新指数行情，请注明行情时间';
  const market = cnMarket(query);
  if (allowNetwork && market === 'unspecified') {
    remember(room, {market: true});
    return direct('你想了解哪个市场？比如 A 股、港股还是美股。');
  }
  const weatherRequest = weatherIntent(query);
  const automatic = currentFacts.some((pattern) => pattern.test(query)) && !/(?:故事|作文|虚构|编一个|写一首|翻译|模拟|假设|是什么意思|是什么原理)/u.test(query);
  if (allowNetwork && (search || retry || marketReply || market || weatherRequest || singleDomesticBulletin(query) || cctvNews.supports(query) || automatic)) {
    const result = await querySearch(query, room, signal, onSearch);
    if (weatherRequest?.target && !weatherRequest.request) remember(room, {weather: weatherRequest.target});
    else if (!result.sources.length && !privateSearch.test(query)) {
      try { remember(room, {retry: validateQuery(query)}); } catch { /* Private or invalid text is never retained for retry. */ }
    }
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
  // The model may request a lookup without supplying arguments. Only the user's
  // current, validated words may leave the service as a search query.
  let allowLookup = allowNetwork && !privateSearch.test(user) && Boolean(searchKey || cpaWebSearchEnabled);
  if (allowLookup) {
    try { validateQuery(user); } catch { allowLookup = false; }
  }
  const quickConversation = voice && !/仔细分析|深入|详细推导|分步推理|深度思考|认真分析|详细分析/u.test(user);
  for await (const delta of chatDeltas(policy ? `${prompt}\n\n${policy}` : prompt,
    [...stripClockTurns(history), { role: 'user', content: user }], signal, allowLookup, quickConversation)) {
    if ('search' in delta) {
      const result = await querySearch(user, room, signal);
      await forward(result.text);
      return { text, sources: result.sources, tool: 'search', excluded: true };
    }
    await forward(claimFilter.feed(parens.feed(exits.feed(delta.text).text)));
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
  const run = async (onText: (text: string) => Promise<void>, onSearch?: () => void) => {
    const reply = await answer(room, messages, store, signal, onText, onSearch, isVoiceCompletion(tagged, !!c.req.header('x-personal-session')));
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
      const write = (text: string) => chunk({ content: text }, null);
      const reply = isVoiceCompletion(tagged, !!c.req.header('x-personal-session'))
        ? await withVoiceProgress(room, run, write, signal)
        : await run(write);
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
