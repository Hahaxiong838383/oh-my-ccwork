/** Offline contract tests for the 中国天气网 7-day fallback; live cases are opt-in (WEATHER_FALLBACK_LIVE=1). */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const p003 = join(here, '../../../P003GameDemo20260513/apps/server/src/tools');

// The deployed image stages p003 next to server.ts; stage the same shape beside a copy
// of the module under test so `./p003/tools/weather-places.js` resolves while running.
const stage = mkdtempSync(join(tmpdir(), 'pa-weather-'));
mkdirSync(join(stage, 'p003/tools'), {recursive: true});
for (const name of ['weather-fallback.ts','public-queries.ts']) copyFileSync(join(here, name), join(stage, name));
copyFileSync(join(p003, 'weather-places.ts'), join(stage, 'p003/tools/weather-places.ts'));
copyFileSync(join(p003, 'weather-places.json'), join(stage, 'p003/tools/weather-places.json'));
writeFileSync(join(stage, 'p003/tools/weather-places.js'), "export * from './weather-places.ts';\n");
after(() => rmSync(stage, {recursive: true, force: true}));

const {forecastFallback} = await import(pathToFileURL(join(stage, 'weather-fallback.ts')).href);

const {weatherIntent, followupPlace, domesticBulletin} = await import(pathToFileURL(join(stage, 'public-queries.ts')).href);
test('ordinary spoken news keeps date, requested count and subject', () => {
  assert.deepEqual(domesticBulletin('今天国内有什么新闻？'), {query:'央视今天国内新闻',count:2});
  assert.deepEqual(domesticBulletin('今天有什么新闻'), {query:'央视今天国内新闻',count:2});
  assert.deepEqual(domesticBulletin('现在国内有什么新闻给我讲一条就好'), {query:'央视今天国内新闻',count:1});
  assert.deepEqual(domesticBulletin('最近国内有哪些新闻？'), {query:'央视最新国内新闻',count:2});
  for (const q of ['昨天国内有什么新闻','三条国内新闻','我国航天最新新闻','中国股市最新新闻','今天国际新闻',
    '国内有财经新闻吗','新华社今天有什么新闻','新闻是什么意思','不要查新闻']) {
    assert.equal(domesticBulletin(q), undefined, q);
  }
});
test('spoken weather requests keep the complete station, day and metric', () => {
  for (const [text, place, day_offset, metric] of [
    ['你先看看北京的天气怎么样', '北京', 0, 'forecast'],
    ['我在北京，明天要不要带伞？', '北京', 1, 'forecast'],
    ['请你提供一下北京市朝阳区后天的天气预报', '北京市朝阳区', 2, 'forecast'],
    ['你先看看北京朝阳现在的气温', '北京朝阳', 0, 'current'],
    ['先查那曲的空气质量', '那曲', 0, 'aqi'],
    ['小可，请你提供一下北京的天气预报', '北京', 0, 'forecast'],
    ['你只说说北京的天气吧快点', '北京', 0, 'forecast'],
    ['呃北京天气你找不着', '北京', 0, 'forecast'],
    ['明天北京天气，再告诉我需不需要带伞', '北京', 1, 'forecast'],
    ['查查冷水江今天的天气', '冷水江', 0, 'forecast'],
    ['请查会同县的天气', '会同县', 0, 'forecast'],
  ]) assert.deepEqual(weatherIntent(text)?.request, {place, day_offset, metric}, text);
  assert.equal(followupPlace('就看看北京的呗'), '北京');
  assert.equal(followupPlace('就看看北京的Bye'), '北京');
  assert.equal(followupPlace('就看看北京的 bye。'), '北京');
  assert.equal(followupPlace('上海到北京的Bye'), undefined);
  assert.equal(followupPlace('北京大学的Bye'), undefined);
  assert.equal(followupPlace('北京，bye'), undefined);
  assert.equal(followupPlace('bye'), undefined);
  assert.equal(followupPlace('我在北京'), '北京');
  assert.equal(followupPlace('你先看看那曲呢'), '那曲');
  assert.equal(followupPlace('明天北京'), undefined);
  assert.equal(weatherIntent('你看看朝阳的天气')?.ambiguous, true);
  for (const text of ['天气怎么样', '从北京到上海的天气', '查北京大学天气', '不要查北京的天气']) {
    assert.equal(weatherIntent(text)?.request, undefined, text);
  }
});

const TB = 28_800_000;
const day = (ms) => new Date(ms + TB).toISOString().slice(0, 10);
const clock = (ms) => new Date(ms + TB).toISOString().slice(11, 16);
const date = (ms) => `${Number(day(ms).slice(5, 7))}月${Number(day(ms).slice(8, 10))}日`;
const addDays = (value, n) =>
  new Date(Date.parse(value + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (value) => '日一二三四五六'[new Date(value + 'T00:00:00Z').getUTCDay()];
const tags = ['今天', '明天', '后天'];

const PROVINCE = {
  北京: '北京', 海淀: '北京', 上海: '上海', 天津: '天津', 深圳: '广东',
  杭州: '浙江', 成都: '四川', 武汉: '湖北', 南京: '江苏', 长沙: '湖南',
  郑州: '河南', 昆明: '云南', 兰州: '甘肃', 西宁: '青海', 银川: '宁夏', 广州: '广东',
};

const WEEK = [
  {wea: '晴转多云', high: 10, low: 0},
  {wea: '多云转晴', high: 11, low: -1},
  {wea: '晴', high: 10, low: 0},
  {wea: '多云', high: 12, low: 1},
  {wea: '多云转晴', high: 12, low: -1},
  {wea: '晴转小雪', high: 10, low: -1},
  {wea: '阴', high: 5, low: -3},
];

/** Reproduces the real `#7d` block: hidden stamps, seven `li` rows, then the 3h stamp. */
function page(options = {}) {
  const {
    name = '北京', province = PROVINCE[name], at = Date.now() - 2 * 3_600_000,
    days = WEEK, labels = 0, hidden, trail,
  } = options;
  const base = day(at);
  const [month, dateOfMonth] = [Number(base.slice(5, 7)), Number(base.slice(8, 10))];
  const stamp = clock(at);
  const rows = days.map((row, i) => {
    const shown = addDays(base, i + labels);
    const tag = tags[i] ?? '周' + weekday(shown);
    return `<li class="sky skyid lv${(i % 2) + 1}">
<h1>${Number(shown.slice(8, 10))}日（${tag}）</h1>
<p title="${row.wea}" class="wea">${row.wea}</p>
<p class="tem">
<span>${row.high}</span>/<i>${row.low}℃</i>
</p>
</li>`;
  }).join('\n');
  const head = hidden
    ?? `${month}月${dateOfMonth}日${stamp.slice(0, 2)}时 周${weekday(base)}  ${days[0].wea}  ${days[0].high}/${days[0].low}°C`;
  const path = trail ?? (name === province ? [province, '城区'] : [province, name, '城区']);
  const links = path.map((part) => `<a>${part}</a><span>></span>`).join('');
  return `<!DOCTYPE html>
<html><head><title>${name}天气预报,${name}7天天气预报,${name}15天天气预报,${name}天气查询</title></head>
<body>
<div class="ctop clearfix"><div class="crumbs fl"><a href="http://www.weather.com.cn/forecast/" target="_blank">全国</a><span>&gt;</span>${links}</div><div class="time fr"></div></div>
<div id="7d" class="c7d">
<input type="hidden" id="hidden_title" value="${head}" />
<input type="hidden" id="fc_24h_internal_update_time" value="${base.replace(/-/g, '')}${stamp.slice(0, 2)}"/>
<input type="hidden" id="update_time" value="${stamp}"/>
<ul class="t clearfix">
${rows}
</ul>
<i class="line1"></i>
<input type="hidden" id="fc_3h_internal_update_time" value="${base} ${stamp}"/>
</div>
</body></html>`;
}

const body = (value) => new Response(value);
const request = (place, day_offset = 0, metric = 'forecast') => ({place, day_offset, metric});

/** Runs `run` with a stub fetch that always answers with one canned response. */
async function serving(reply, run) {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => reply();
  try { return await run(); } finally { globalThis.fetch = saved; }
}

async function withClock(ms, run) {
  const real = Date.now;
  Date.now = () => ms;
  try { return await run(); } finally { Date.now = real; }
}

/** One place per scenario: the page cache is per station, so scenarios never share a station. */
test('serves today, tomorrow and the day after with a citation', async () => {
  const at = Date.now() - 2 * 3_600_000;
  const fixed = page({at});
  const result = await serving(() => body(fixed), () => forecastFallback(request('北京'), AbortSignal.timeout(5_000), Date.now()));
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'https://www.weather.com.cn/weather/101010100.shtml');
  assert.equal(result.sources[0].title, '中国天气网 · 北京');
  assert.equal(result.sources[0].date, `${day(at)}T${clock(at)}:00+08:00`);
  assert.equal(result.text,
    `中国天气网${date(at)}${clock(at)}预报，北京今天（${date(Date.now())}）白天晴，夜间多云，0到10摄氏度。预报会变化。`);
  assert.ok([...result.text].length <= 150);
  assert.ok(!/https?:\/\//.test(result.text));
});

test('uses the resolved station id for a district and keeps its own wording', async () => {
  const at = Date.now() - 3 * 3_600_000;
  const result = await serving(() => body(page({name: '海淀', at})),
    () => forecastFallback(request('海淀', 1), AbortSignal.timeout(5_000), Date.now()));
  assert.equal(result.sources[0].url, 'https://www.weather.com.cn/weather/101010200.shtml');
  assert.equal(result.text,
    `中国天气网${date(at)}${clock(at)}预报，北京海淀明天（${date(Date.now() + 86_400_000)}）白天多云，夜间晴，-1到11摄氏度。预报会变化。`);
});

test('derives the target date across a month boundary', async () => {
  const at = Date.parse('2026-11-30T22:30:00+08:00');
  await withClock(at + 20 * 60_000, () => serving(() => body(page({name: '上海', at})), async () => {
    const result = await forecastFallback(request('上海', 2), AbortSignal.timeout(5_000), at + 20 * 60_000);
    assert.equal(result.text, '中国天气网11月30日22:30预报，上海后天（12月2日）晴，0到10摄氏度。预报会变化。');
    assert.equal(result.sources[0].date, '2026-11-30T22:30:00+08:00');
  }));
});

test('rejects a page that belongs to another city', async () => {
  const fixed = page({name: '北京'});
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('天津'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_city'});
  });
});

test('rejects a page whose province does not match the station', async () => {
  const fixed = page({name: '深圳', trail: ['北京', '深圳', '城区']});
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('深圳'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_city'});
  });
});

test('rejects an old publish date even when the rows look consistent', async () => {
  const fixed = page({name: '杭州', at: Date.now() - 3 * 86_400_000});
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('杭州'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_stale'});
  });
});

test('rejects rows that lag their publish date', async () => {
  const fixed = page({name: '成都', labels: -2});
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('成都'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_rows'});
  });
});

test('rejects a headline that disagrees with the first row', async () => {
  const at = Date.now() - 2 * 3_600_000;
  const base = day(at);
  const fixed = page({
    name: '武汉', at,
    hidden: `${Number(base.slice(5, 7))}月${Number(base.slice(8, 10))}日${clock(at).slice(0, 2)}时 周${weekday(base)}  大雨  20/10°C`,
  });
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('武汉'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_rows'});
  });
});

test('rejects a page without a full publish date', async () => {
  const fixed = page({name: '南京'}).replace(/<input type="hidden" id="fc_3h_internal_update_time"[^>]*>/, '');
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('南京'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_timestamp'});
  });
});

test('rejects an impossible temperature', async () => {
  const fixed = page({name: '长沙', days: [{wea: '晴', high: 999, low: 0}, ...WEEK.slice(1)]});
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('长沙'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_temperature'});
  });
});

test('rejects a night warmer than the day', async () => {
  const fixed = page({name: '郑州', days: [{wea: '晴', high: -1, low: 8}, ...WEEK.slice(1)]});
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('郑州'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_temperature'});
  });
});

test('rejects wording outside the published vocabulary', async () => {
  const fixed = page({name: '昆明', days: [{wea: '晴炸', high: 10, low: 0}, ...WEEK.slice(1)]});
  await serving(() => body(fixed), async () => {
    await assert.rejects(forecastFallback(request('昆明'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_wording'});
  });
});

test('rejects a placeholder page', async () => {
  await serving(() => body('<!-- empty -->'), async () => {
    await assert.rejects(forecastFallback(request('兰州'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_page'});
  });
});

test('rejects a body over the size budget', async () => {
  await serving(() => new Response(new Uint8Array(300_000)), async () => {
    await assert.rejects(forecastFallback(request('西宁'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_body_limit'});
  });
});

test('rejects a non-200 response instead of reading it', async () => {
  await serving(() => new Response('busy', {status: 503}), async () => {
    await assert.rejects(forecastFallback(request('广州'), AbortSignal.timeout(5_000), Date.now()), {message: 'weather_http_503'});
  });
});

test('stops when the caller aborts', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('stub_abort')), {once: true});
  });
  try {
    const controller = new AbortController();
    const pending = forecastFallback(request('银川'), controller.signal, Date.now());
    setTimeout(() => controller.abort(new Error('caller_stopped')), 30);
    await assert.rejects(pending, {message: 'caller_stopped'});
  } finally { globalThis.fetch = saved; }
});

test('serves forecast only', async () => {
  for (const metric of ['current', 'aqi']) {
    await assert.rejects(forecastFallback(request('北京', 0, metric), AbortSignal.timeout(1_000), Date.now()), {message: 'weather_metric_unsupported'});
  }
});

test('rejects an unresolved or ambiguous place before fetching', async () => {
  await assert.rejects(forecastFallback(request('不存在的城市'), AbortSignal.timeout(1_000), Date.now()), {message: 'weather_place_unknown'});
  await assert.rejects(forecastFallback(request('西安'), AbortSignal.timeout(1_000), Date.now()), /^Error: weather_place_/u);
});

test('re-validates a cached page instead of replaying its answer', async () => {
  await serving(() => body(page({})), async () => {
    const ok = await forecastFallback(request('北京'), AbortSignal.timeout(5_000), Date.now());
    assert.match(ok.text, /^中国天气网/u);
    await assert.rejects(
      forecastFallback(request('北京'), AbortSignal.timeout(5_000), Date.now() + 40 * 86_400_000),
      {message: 'weather_target_date'},
    );
  });
});

test('live: multi-city 7-day pages', {skip: process.env.WEATHER_FALLBACK_LIVE !== '1' && 'set WEATHER_FALLBACK_LIVE=1'}, async () => {
  for (const place of ['北京', '上海', '深圳', '三亚', '海淀', '乌鲁木齐']) {
    for (const offset of [0, 1, 2]) {
      const result = await forecastFallback(request(place, offset), AbortSignal.timeout(9_000), Date.now());
      assert.match(result.text, /^中国天气网\d{1,2}月\d{1,2}日\d{2}:\d{2}预报，.+，-?\d{1,2}到-?\d{1,2}摄氏度。预报会变化。$/u);
      assert.ok([...result.text].length <= 150, result.text);
      assert.ok(!/https?:\/\//.test(result.text));
      assert.equal(result.sources.length, 1);
      assert.match(result.sources[0].url, /^https:\/\/www\.weather\.com\.cn\/weather\/101\d{6}\.shtml$/u);
      assert.match(result.sources[0].date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/u);
    }
  }
});
