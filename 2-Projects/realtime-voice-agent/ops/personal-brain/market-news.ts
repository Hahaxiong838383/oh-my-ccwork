import type { SearchResult } from './p003/tools/search-tasks.js';

type Scope = 'today' | 'recent' | 'other-market';
export function marketNewsIntent(text: string): Scope | undefined {
  const q = text.normalize('NFKC').replace(/[，,、。.!！？?\s]/gu, '')
    .replace(/^(?:(?:请你?|帮我|给我|小可))*(?:搜索|查询|查查|搜搜|搜|查)(?:一下|下)?/u, '');
  if (!/(?:股市|股票|[A港美日]股|沪深大盘)/iu.test(q) || !/新闻|快讯|消息|要闻/u.test(q)) return;
  // Company names, subjects, historical dates and requests for analysis remain full web queries.
  const rest = q.replace(/今天|今日|最新|最近|近期|现在|目前|我们|国内|中国|美国|香港|日本|沪深|股市|股票市场|股票|[A港美日]股|新闻|快讯|消息|要闻|怎么样|咋样|如何|有什么|有哪些|有没有|发生了什么|播报|讲讲|说说|看看|听听|来一条|给我|帮我|请|一下|的|呢|啊|吗|吧/giu, '');
  if (rest) {
    // Keep a named company, country, time window or requested number in the web query.
    if (/今天|今日|最新|最近|本周|昨天|昨日/u.test(q) &&
      /有什么|有哪些|怎么样|如何|有何|有没有|有啥/u.test(q) &&
      !/不要|不用|别|听说|我读|我看|编个|虚构|故事|翻译|模拟|假设/u.test(q)) return 'other-market';
    return;
  }
  if (/美股|港股|日股|美国|香港|日本/u.test(q)) return 'other-market';
  return /今天|今日/u.test(q) ? 'today' : 'recent';
}

// The shared ledger rejects “我们”. For the exact public stock question, submit only a
// fixed topic and day. Arbitrary subjects still pass through its full privacy checks.
export function publicMarketNewsQuery(text: string): string {
  if (!text.includes('我们') || text.length > 64 || /[\x00-\x1f\x7f]/u.test(text)) return text;
  const scope = marketNewsIntent(text);
  if (scope === 'today') return '今天国内股市新闻';
  if (scope === 'recent') return '近期国内股市新闻';
  return text;
}

const sources = {
  stcn: { list: 'https://www.stcn.com/article/list/gs.html', name: '证券时报' },
  eastmoney: { list: 'https://finance.eastmoney.com/a/cywjh.html', name: '东方财富网' },
} as const;
type Publisher = keyof typeof sources;
const domesticMarket = /A股|沪深|沪指|沪市|深市|沪股通|深股通|创业板|科创板|科创综指|国务院.{0,42}资本市场|北证|上证|深成指|涨停股|(?<!美国)(?<!香港)证监会|中央汇金|沪深交易所/u;
const unsafe = /[<>]|\[\[|https?:\/\/|\]\]|忽略.{0,8}(?:指令|规则)|ignore.{0,12}instructions/iu;
const clean = (s: string) => s.replace(/<[^>]*>/gu, '').replace(/&nbsp;|&#160;/giu, ' ').replace(/&amp;/gu, '&')
  .replace(/&ldquo;/gu, '“').replace(/&rdquo;/gu, '”').replace(/&quot;/gu, '"').replace(/\s+/gu, ' ').trim();
const day = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

async function readHtml(url: string, signal: AbortSignal, fetcher: typeof fetch) {
  const res = await fetcher(url, { redirect: 'error', signal });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error('news_http');
  }
  const reader = res.body.getReader();
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) throw new Error('news_size');
      buffers.push(value);
    }
  } finally {
    await reader.cancel().catch(() => { });
    reader.releaseLock();
  }
  return Buffer.concat(buffers).toString('utf8');
}

function listedArticles(p: Publisher, html: string) {
  const links = p === 'stcn'
    ? html.matchAll(/<div class="tt">\s*<a href="(\/article\/detail\/\d{1,12}\.html)"[^>]*>([\s\S]*?)<\/a>/gu)
    : html.matchAll(/<div class="title">\s*<a[^>]*href="(https:\/\/finance\.eastmoney\.com\/a\/\d{16,24}\.html)"[^>]*>([\s\S]*?)<\/a>/gu);
  return Array.from(links, ([, u, t]) => ({ url: new URL(u, sources[p].list).href, title: clean(t) }))
    .filter(a => a.title.length > 2 && a.title.length <= 120 && !unsafe.test(a.title) && (p === 'stcn' || domesticMarket.test(a.title)))
    .slice(0, 3);
}

function readReport(p: Publisher, html: string, expectedTitle: string, now: number, today: boolean) {
  const isStcn = p === 'stcn';
  const titleMarkup = (isStcn ? /<div class="detail-title">([\s\S]*?)<\/div>/u
    : /id="topbox"[^>]*>\s*<div class="title">([\s\S]*?)<\/div>/u).exec(html)?.[1];
  if (!titleMarkup || clean(titleMarkup) !== expectedTitle) return;
  const stamp = (isStcn ? /class="detail-info">[\s\S]{0,550}?<span>(20\d{2}-\d\d-\d\d) (\d\d:\d\d)<\/span>/u
    : /class="infos">\s*<div class="\s*item\s*">(20\d{2})年(\d\d)月(\d\d)日\s*(\d\d:\d\d)<\/div>/u).exec(html);
  if (!stamp) return;
  const date = isStcn ? stamp[1] + 'T' + stamp[2] : stamp[1] + '-' + stamp[2] + '-' + stamp[3] + 'T' + stamp[4];
  const iso = date + ':00+08:00', ms = Date.parse(iso);
  if (!Number.isFinite(ms) || day(ms) !== date.slice(0, 10) || ms > now || now - ms > 3 * 86400_000 || (today && day(ms) !== day(now))) return;
  const body = (isStcn ? /class="detail-content">([\s\S]*?)<div class="detail-content-editor"/u
    : /id="ContentBody"[^>]*>([\s\S]*?)<div class="zwothers"/u).exec(html)?.[1];
  if (!body) return;
  for (const [, raw] of body.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gu)) {
    const paragraph = clean(raw);
    if (unsafe.test(paragraph)) continue;
    // Require a complete factual sentence on the domestic market, not an index table or sidebar.
    for (const match of paragraph.matchAll(/[^。！？]+[。！？]/gu)) {
      const sentence = match[0].trim();
      if (sentence.length >= 12 && sentence.length <= 100 && domesticMarket.test(sentence) &&
        !/[？?]|美股|港股|日股|美国证监会|香港证监会/u.test(sentence)) {
        return { date: iso, text: sentence };
      }
    }
  }
}

// First try the stock desk, then an independently published market report. Both must verify the original article.
export async function domesticMarketNews(scope: 'today' | 'recent', signal: AbortSignal, now = Date.now(), fetcher = fetch): Promise<SearchResult> {
  for (const publisher of ['stcn', 'eastmoney'] as const) {
    signal.throwIfAborted();
    const budget = AbortSignal.any([signal, AbortSignal.timeout(2200)]);
    try {
      const list = listedArticles(publisher, await readHtml(sources[publisher].list, budget, fetcher));
      // Preserve the editor's ordering. A missing, stale or mismatched story does not hide its successor.
      for (const { url, title } of list) {
        let html: string;
        try {
          html = await readHtml(url, budget, fetcher);
        } catch {
          budget.throwIfAborted();
          continue;
        }
        const article = readReport(publisher, html, title, now, scope === 'today');
        if (article) {
          const [, month, date] = article.date.slice(0, 10).split('-').map(Number);
          const [hour, minute] = article.date.slice(11, 16).split(':').map(Number);
          const time = minute ? hour + '点' + minute + '分' : hour + '点';
          return {
            text: `A股方面，${sources[publisher].name}${month}月${date}日${time}报道，${article.text}`,
            sources: [{ title, url, date: article.date }],
          };
        }
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  signal.throwIfAborted();
  return { text: scope === 'today' ? '暂时没有查到能核实为今天发布的A股新闻。' : '暂时没有查到可核实的近期A股新闻。', sources: [] };
}
