/**
 * Bounded public reader for 中国天气网 7 日网页预报 (`/weather/<站号>.shtml`).
 * Public HTML is data, never executable code or prompt instructions. Every field
 * is re-derived and cross-checked on each call; nothing about a page is trusted
 * because a previous call accepted it.
 */
import {resolveWeatherPlace, type WeatherPlace} from './p003/tools/weather-places.js';
import type {PlaceWeatherRequest} from './p003/tools/baidu-weather.js';
import type {SearchResult} from './p003/tools/search-tasks.js';

const TB = 28_800_000; // +08:00, no DST in China
const PAGE = 'https://www.weather.com.cn/weather/';
const MAX_BYTES = 262_144;
const TIMEOUT_MS = 4_000;
const CACHE_MS = 300_000;
const COOLDOWN_MS = 20_000;
const FRESH_MS = 6 * 3_600_000;
const BURST = {window: 60_000, limit: 30};
const ROWS = 7;
const USER_AGENT = 'xiaoke-personal-weather/1.0 (+public 7-day page, no credentials)';

/** A declaration (not an arrow) so `if (!value) fail(...)` narrows the type. */
function fail(code: string): never { throw new Error('weather_' + code); }
const day = (ms: number) => new Date(ms + TB).toISOString().slice(0, 10);
const clock = (ms: number) => new Date(ms + TB).toISOString().slice(11, 16);
const addDays = (date: string, n: number) =>
  new Date(Date.parse(date + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string) => '日一二三四五六'[new Date(date + 'T00:00:00Z').getUTCDay()];
const strip = (html: string) =>
  html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/** 中国天气网 uses this closed vocabulary on the 7-day list; anything else is rejected. */
const WORDS = new Set([
  '晴', '多云', '阴', '雾', '大雾', '浓雾', '霾', '浮尘', '扬沙', '沙尘', '沙尘暴', '强沙尘暴',
  '雨', '小雨', '中雨', '大雨', '暴雨', '大暴雨', '特大暴雨', '阵雨', '雷阵雨', '雷雨', '雷暴',
  '雪', '小雪', '中雪', '大雪', '暴雪', '阵雪', '雨夹雪', '冻雨', '冰雹', '霜冻', '雾凇',
  '风', '大风', '强对流', '高温', '寒冷', '雷',
]);
const RANGE = /^(?:小|中|大|暴|特大)到(?:小|中|大|暴)?(?:雨|雪|雨夹雪)$/;

function wording(raw: unknown, code = 'wording'): string {
  if (typeof raw !== 'string') fail(code);
  const text = raw.trim();
  if (!/^[\u4e00-\u9fff]{1,12}$/u.test(text)) fail(code);
  for (const part of text.split(/转|间/u)) {
    if (!part || (!WORDS.has(part) && !RANGE.test(part))) fail(code);
  }
  return text;
}

function temperature(raw: string | undefined, code = 'temperature'): number {
  if (typeof raw !== 'string' || !/^-?\d{1,2}$/.test(raw)) fail(code);
  const value = Number(raw);
  if (!(value >= -70 && value <= 60)) fail(code);
  return value;
}

type Stamp = {date: string; time: string; ms: number; hidden: string};
type Row = {date: string; wea: string; high: number; low: number};

/** Full publish date: an exact `YYYY-MM-DD HH:MM`, its clock, the 24h cycle date and the title line must agree. */
function published(html: string): Stamp {
  const field = (id: string) =>
    new RegExp('id="' + id + '"[^>]{0,80}?value="([^"]{1,80})"').exec(html)?.[1];
  const hidden = field('hidden_title');
  const cycle = field('fc_24h_internal_update_time');
  const exact = field('fc_3h_internal_update_time');
  const shown = field('update_time');
  if (!hidden || !cycle || !exact || !shown) fail('timestamp');
  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(exact);
  if (!parts) fail('timestamp');
  const [year, month, date, hour, minute] = parts.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, date, hour, minute) - TB;
  const local = day(ms), time = clock(ms);
  if (!Number.isFinite(ms) || local !== exact.slice(0, 10) || time !== exact.slice(11)) fail('timestamp');
  if (!/^\d{10}$/.test(cycle) || cycle.slice(0, 8) !== local.replace(/-/g, '')) fail('timestamp');
  if (!/^\d{2}:\d{2}$/.test(shown) || shown !== time) fail('timestamp');
  return {date: local, time, ms, hidden};
}

/** The page identity: 全国 > 省 > [市] > [区/城区] must contain exactly this place. */
function identify(html: string, place: WeatherPlace): void {
  const crumbs = /<div class="crumbs fl">([\s\S]{0,800}?)<\/div>/.exec(html)?.[1];
  const title = /<title>([\s\S]{0,200}?)<\/title>/.exec(html)?.[1];
  if (!crumbs || !title) fail('page');
  const path = strip(crumbs).split('>').map((part) => part.trim()).filter(Boolean);
  if (path[0] !== '全国') fail('page');
  const trail = path.slice(1);
  if (trail.length < 2 || trail.length > 4) fail('city');
  if (trail[0] !== place.province || !trail.includes(place.name)) fail('city');
  const last = trail[trail.length - 1];
  if (last !== place.name && last !== '城区') fail('city');
  if (!strip(title).startsWith(place.name + '天气预报,')) fail('city');
}

function forecast(html: string, base: string): Row[] {
  const list = /<ul class="t clearfix">([\s\S]{0,16000}?)<\/ul>/.exec(html)?.[1];
  if (!list) fail('page');
  const items = [...list.matchAll(/<li[^>]{0,80}>([\s\S]{0,1200}?)<\/li>/g)].map((m) => m[1]);
  if (items.length !== ROWS) fail('rows');
  return items.map((item, i) => {
    const label = strip(/<h1>([\s\S]{0,40}?)<\/h1>/.exec(item)?.[1] ?? '');
    const tag = /^(\d{1,2})日（(今天|明天|后天|周[日一二三四五六])）$/.exec(label);
    const expect = addDays(base, i);
    if (!tag || Number(tag[1]) !== Number(expect.slice(8, 10))) fail('rows');
    const want = ['今天', '明天', '后天'][i] ?? '周' + weekday(expect);
    if (tag[2] !== want) fail('rows');
    const wea = wording(strip(/<p[^>]{0,60}class="wea"[^>]{0,60}>([\s\S]{0,40}?)<\/p>/.exec(item)?.[1] ?? ''));
    const tem = /<p class="tem">\s*<span>(-?\d{1,2})<\/span>\s*\/\s*<i>(-?\d{1,2})℃<\/i>/.exec(item);
    const high = temperature(tem?.[1]);
    const low = temperature(tem?.[2]);
    if (low > high) fail('temperature');
    return {date: expect, wea, high, low};
  });
}

/** The headline line repeats today's word, high and low; the date and weekday must match the publish day. */
function headline(stamp: Stamp, rows: Row[]) {
  const parsed = /^(\d{1,2})月(\d{1,2})日(\d{2})时\s*周([日一二三四五六])\s+(\S{1,12})\s+(-?\d{1,2})\/(-?\d{1,2})°C$/
    .exec(stamp.hidden.trim());
  if (!parsed) fail('timestamp');
  const [, month, date, , weekdayText, wea, high, low] = parsed;
  const first = rows[0];
  if (Number(month) !== Number(stamp.date.slice(5, 7)) || Number(date) !== Number(stamp.date.slice(8, 10))) fail('timestamp');
  if (weekdayText !== weekday(stamp.date)) fail('timestamp');
  if (wording(wea, 'wording') !== first.wea) fail('rows');
  // The headline rounds or lags the list by a degree on some stations (observed 11/-4 vs 11/-5).
  if (Math.abs(temperature(high) - first.high) > 2 || Math.abs(temperature(low) - first.low) > 2) fail('rows');
}

type Flight = {html: string; cached: boolean};
const pages = new Map<string, {at: number; html: string}>();
const flights = new Map<string, Promise<string>>();
const cooldown = new Map<string, number>();
let hits: number[] = [];

async function read(station: string): Promise<string> {
  const now = Date.now();
  hits = hits.filter((t) => t > now - BURST.window);
  if (hits.length >= BURST.limit) fail('rate_limit');
  hits.push(now);
  const response = await fetch(PAGE + station + '.shtml', {
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {Accept: 'text/html', 'User-Agent': USER_AGENT},
  });
  if (!response.ok) { await response.body?.cancel(); fail('http_' + response.status); }
  const reader = response.body?.getReader();
  if (!reader) fail('empty');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) fail('body_limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One fetch per station, shared by concurrent callers; each caller still re-validates the page. */
async function page(station: string, signal: AbortSignal): Promise<Flight> {
  const cached = pages.get(station);
  if (cached && Date.now() - cached.at < CACHE_MS) return {html: cached.html, cached: true};
  if ((cooldown.get(station) ?? 0) > Date.now()) fail('cooldown');
  let flight = flights.get(station);
  if (!flight) {
    const started = Date.now();
    flight = read(station)
      .then((html) => {
        pages.set(station, {at: started, html});
        if (pages.size > 32) pages.delete(pages.keys().next().value!);
        return html;
      })
      .catch((error) => {
        cooldown.set(station, Date.now() + COOLDOWN_MS);
        if (cooldown.size > 32) cooldown.delete(cooldown.keys().next().value!);
        throw error;
      })
      .finally(() => { if (flights.get(station) === flight) flights.delete(station); });
    flights.set(station, flight);
  }
  const shared = flight;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (html: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve({html, cached: false});
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new Error('weather_aborted'));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, {once: true});
    shared.then(finish, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

function build(html: string, place: WeatherPlace, q: PlaceWeatherRequest, now: number, requestedAt: number): SearchResult {
  identify(html, place);
  const stamp = published(html);
  const age = now - stamp.ms;
  if (!Number.isFinite(age) || age < -300_000 || age > FRESH_MS) fail('stale');
  const rows = forecast(html, stamp.date);
  headline(stamp, rows);
  const target = day(requestedAt + q.day_offset * 86_400_000);
  const row = rows.find((item) => item.date === target);
  if (!row) fail('target_date');
  const which = ['今天', '明天', '后天'][q.day_offset];
  const when = `${Number(target.slice(5, 7))}月${Number(target.slice(8, 10))}日`;
  const [daytime, night] = row.wea.split('转');
  const sky = night ? `白天${daytime}，夜间${night}` : row.wea;
  const text = `中国天气网${Number(stamp.date.slice(5, 7))}月${Number(stamp.date.slice(8, 10))}日${stamp.time}预报，`
    + `${place.label}${which}（${when}）${sky}，${row.low}到${row.high}摄氏度。预报会变化。`;
  const url = PAGE + place.station + '.shtml';
  return {text, sources: [{title: '中国天气网 · ' + place.label, url, date: `${stamp.date}T${stamp.time}:00+08:00`}]};
}

/**
 * 7-day forecast fallback for one resolved place and day. Only `metric: 'forecast'`
 * is served; a page that is off-site, undated, frozen, malformed or without the
 * target day throws instead of answering with a guess.
 */
export async function forecastFallback(q: PlaceWeatherRequest, signal: AbortSignal, requestedAt: number): Promise<SearchResult> {
  signal.throwIfAborted();
  if (!q || typeof q.place !== 'string' || !/^[\u4e00-\u9fff]{1,40}$/u.test(q.place)) fail('request');
  if (!Number.isInteger(q.day_offset) || q.day_offset < 0 || q.day_offset > 2) fail('request');
  if (!Number.isFinite(requestedAt)) fail('request');
  if (q.metric !== 'forecast') fail('metric_unsupported');
  const place = resolveWeatherPlace(q.place);
  const now = Date.now();
  let flight = await page(place.station, signal);
  signal.throwIfAborted();
  try {
    return build(flight.html, place, q, now, requestedAt);
  } catch (error) {
    // A page kept from an earlier minute can age past the freshness window: refetch once.
    if (!flight.cached) throw error;
    pages.delete(place.station);
    flight = await page(place.station, signal);
    signal.throwIfAborted();
    return build(flight.html, place, q, now, requestedAt);
  }
}
