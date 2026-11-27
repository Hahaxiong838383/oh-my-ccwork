import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const base = process.env.BRAIN_VERIFY_URL ?? 'http://127.0.0.1:8080';
const key = process.env.BRAIN_WORKER_KEY ?? process.env.LLM_API_KEY;
assert.ok(key, 'worker key required');
const url = base + '/v1/chat/completions';
const profile = process.env.BRAIN_VERIFY_DATA
  ? new DatabaseSync(process.env.BRAIN_VERIFY_DATA + '/profile.sqlite', { readOnly: true }) : null;
const conversations = process.env.BRAIN_VERIFY_DATA
  ? new DatabaseSync(process.env.BRAIN_VERIFY_DATA + '/conversations.sqlite', { readOnly: true }) : null;

function request(question, session, opts = {}) {
  return fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(65_000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...(session ? { 'X-Personal-Session': session } : {}), ...opts.headers },
    body: JSON.stringify({ model: 'personal-brain', messages: [{ role: 'user', content: question }],
      store: Boolean(profile), ...opts.body }),
  });
}
async function chat(question, session, opts) {
  const res = await request(question, session, opts);
  assert.equal(res.status, 200);
  const reply = await res.json();
  assert.ok(reply.choices?.[0]?.message?.content?.trim(), 'assistant text');
  assert.equal(reply.choices[0].finish_reason, 'stop');
  return { text: reply.choices[0].message.content, sources: reply.sources, tool: reply.tool };
}
function streamEvents(body) {
  return body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
}
assert.equal((await request('现在几点？', 'verify-unauthorized', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
assert.equal((await request('现在几点？', '../../wrong')).status, 400);
for (const question of ['你能联网搜索吗？', '小可，你有哪些工具？']) {
  const result = await chat(question, 'verify-capability', { body: { store: false } });
  assert.equal(result.tool, 'capabilities');
  assert.match(result.text, /可以.*查.*天气.*时间/u);
  assert.equal(result.sources, undefined);
}
const clock = await chat('伦敦现在几点？', 'verify-clock');
assert.equal(clock.tool, 'clock');
assert.match(clock.text, /^伦敦现在是.+点/);
for (const question of ['先停一下现在北京时间是几点', '等一下，伦敦现在几点？']) {
  const answer = await chat(question, 'verify-spoken-interrupt', { body: { store: false } });
  assert.equal(answer.tool, 'clock');
  assert.match(answer.text, question.includes('北京') ? /北京时间.+点/ : /^伦敦现在是.+点/u);
}
const weekday = await chat('北京今天星期几？', 'verify-clock');
assert.equal(weekday.text, '今天是' + new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', weekday: 'long',
}).format(new Date()) + '。');
console.log('authentication and deterministic time tool passed');

const warm = await request('hi', null, { body: { stream: true, store: true, max_tokens: 8 } });
assert.equal(warm.status, 200);
const warmBody = await warm.text();
assert.match(warmBody, /"finish_reason":"stop"[\s\S]*data: \[DONE\]/);
assert.ok(!warmBody.includes('"content"'));
if (conversations) assert.equal(conversations.prepare("SELECT 1 FROM conversation WHERE text='hi'").get(), undefined);
console.log('worker prewarm leaves no transcript');

if (process.env.BRAIN_VERIFY_SKIP_SEARCH !== '1') {
  const search = await request('帮我查查央视最新新闻', 'verify-search', { body: { stream: true } });
  assert.equal(search.status, 200);
  const payloads = streamEvents(await search.text());
  assert.equal(payloads.pop(), '[DONE]');
  const events = payloads.map((line) => JSON.parse(line));
  const last = events.at(-1);
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.equal(last.tool, 'search');
  const source = last.sources?.[0];
  assert.ok(source?.title && source.date, 'verified source and publication date');
  assert.match(source.url, /^https:\/\/news\.cctv\.com\/20\d\d\//);
  const text = events.map((event) => event.choices[0].delta.content ?? '').join('');
  assert.ok(text && !text.includes('https://'));
  const resume = await chat('继续刚才的搜索结果', 'verify-search');
  assert.equal(resume.text, text);
  assert.deepEqual(resume.sources, last.sources);
  assert.equal((await chat('继续刚才的搜索结果', 'verify-other-room')).sources, undefined);
  console.log('live search, citations and room-scoped continuation passed', source.url);
  if (process.env.BRAIN_VERIFY_WEATHER === '1') {
    // Use distinct production-shaped room IDs and independent HTTP requests.
    const room = 'pv-' + crypto.randomUUID().replaceAll('-', '');
    const other = 'pv-' + crypto.randomUUID().replaceAll('-', '');
    const clarification = await chat('今天天气怎么样', room, {body: {store: false}});
    assert.match(clarification.text, /哪个城市/);
    assert.deepEqual((await chat('再查查呗', other, {body: {store: false}})).sources, undefined);
    const follow = await chat('就看看北京的呗', room, {body: {store: false}});
    assert.equal(follow.tool, 'weather');
    assert.match(follow.text, /北京/);
    assert.ok(follow.sources.some(s => /^https:\/\//.test(s.url)));
    const scoped = await chat('今天股票市场怎么样', room, {body: {store: false}});
    assert.match(scoped.text, /哪个市场/);
    const market = await chat('那那A股呢', room, {body: {store: false}});
    assert.equal(market.tool, 'search');
    assert.match(market.text, /截至.*上证指数.*创业板指/);
    assert.equal(market.sources.filter(s => new URL(s.url).hostname === 'gu.qq.com').length, 3);

    const weather = await chat('你先看看北京的天气怎么样', 'verify-weather');
    assert.equal(weather.tool, 'weather');
    assert.match(weather.text, /北京.*摄氏度/);
    assert.ok(weather.sources?.[0]?.date);
    assert.match(weather.sources[0].url, /^https:\/\/(?:weathernew\.pae\.baidu\.com|www\.moji\.com|www\.weather\.com\.cn)\//);
    const noCity = await chat('今天出门要带伞吗？', 'verify-weather-no-city');
    assert.match(noCity.text, /哪个城市/);
    assert.equal(noCity.sources.length, 0);
    const walk = await chat('介绍一下雨后散步的感受', room, {body: {store: false}});
    assert.equal(walk.tool, undefined, 'walk should go through ordinary chat');
    assert.equal(walk.sources, undefined);
    assert.doesNotMatch(walk.text, /查哪个城市|告诉我.{0,6}城市/);
    assert.match(walk.text, /脚步|雨|泥土|地面|路|空气|水|叶|散步/);
    console.log('live weather source, missing-city clarification and rain-themed conversation passed');
  }
}

if (process.env.BRAIN_VERIFY_SINGLE_CCTV === '1') {
  const bulletin = await chat('现在国内有什么新闻给我讲一条就好', 'verify-single-domestic', { body: { store: false } });
  assert.equal(bulletin.tool, 'search');
  assert.equal(bulletin.sources?.length, 1);
  const [article] = bulletin.sources;
  assert.match(article.url, /^https:\/\/news\.cctv\.com\/[0-9/]+\/ARTI.+\.shtml$/);
  assert.ok(article.date && bulletin.text.includes(article.title));
  const general = await chat('今天国内有什么新闻？', 'verify-domestic-bulletin', {body:{store:false}});
  assert.equal(general.tool,'search');
  assert.ok(general.sources?.length >= 1 && general.sources.length <= 2);
  for (const source of general.sources) {
    assert.equal(new URL(source.url).hostname,'news.cctv.com');
    assert.ok(source.date && general.text.includes(source.title));
  }
  console.log('single current domestic bulletin delivered its verified article', article.url);
}

if (process.env.BRAIN_VERIFY_CPA_SEARCH === '1') {
  const question = '你能不能帮我查一下 Python 3.14 官方更新说明或 3.14.0 发布公告，首个正式版本是哪天发布的？';
  const room = 'verify-cpa-web';
  const response = await request(question, room, { body: { stream: true, store: false } });
  assert.equal(response.status, 200);
  const payloads = streamEvents(await response.text());
  assert.equal(payloads.pop(), '[DONE]');
  const events = payloads.map(JSON.parse);
  assert.ok(events.slice(0, -1).every((event) => event.tool === undefined && event.sources === undefined));
  const last = events.at(-1);
  assert.deepEqual(last.choices, [{ index: 0, delta: {}, finish_reason: 'stop' }]);
  assert.equal(last.tool, 'search');
  const source = last.sources?.find(({ url }) => {
    const link = new URL(url);
    return link.protocol === 'https:' && (
      link.hostname === 'docs.python.org' && /\/whatsnew\/3\.14\.html$/.test(link.pathname) ||
      link.hostname === 'www.python.org' && link.pathname === '/downloads/release/python-3140/' ||
      link.hostname === 'peps.python.org' && link.pathname === '/pep-0745/'
    );
  });
  assert.ok(source?.title, 'live CPA search must cite a Python primary source that contains the release date');
  assert.equal(source.date, null);
  const text = events.map((event) => event.choices[0].delta.content ?? '').join('');
  assert.match(text, /2025\s*年\s*10\s*月\s*7\s*[日号]/u);
  assert.doesNotMatch(text, /https?:\/\/|\[[^\]]*\]/);
  const resume = await chat('继续刚才的搜索结果', room, { body: { store: false } });
  assert.deepEqual(resume, { text, tool: 'search', sources: last.sources });
  const blocked = await chat('帮我查查你记得上次我说过什么', `${room}-private`, { body: { store: false } });
  assert.equal(blocked.tool, 'search');
  assert.match(blocked.text, /不能直接发到网上/);
  assert.deepEqual(blocked.sources, []);

  const cancelling = await request(question, `${room}-cancel`, { body: { stream: true, store: false } });
  assert.equal(cancelling.status, 200);
  const pending = cancelling.text();
  const cancel = await chat('取消搜索', `${room}-cancel`, { body: { store: false } });
  assert.equal(cancel.tool, 'search_cancel');
  const cancelled = streamEvents(await pending).map(JSON.parse);
  assert.ok(cancelled.at(-1)?.error);
  assert.ok(cancelled.every((event) => event.sources === undefined));
  assert.equal((await chat('继续刚才的搜索结果', `${room}-cancel`, { body: { store: false } })).sources, undefined);
  console.log('live CPA web search, terminal citations, privacy guard and cancellation passed', source.url);
}

if (profile) {
  // BRAIN_VERIFY_DATA belongs to a disposable instance. A clean owner is the blank-memory control.
  const owner = process.env.BRAIN_OWNER_ID;
  assert.ok(owner, 'isolated verification owner required');
  const template = () => profile.prepare('SELECT template FROM trait_template WHERE account_id=?').get(owner)?.template ?? 'default';
  async function direct(question, room, tool, opts) {
    const reply = await chat(question, room, opts);
    assert.equal(reply.tool, tool, question);
    assert.equal(reply.sources, undefined, question);
    return reply.text;
  }
  function sourceFor(kind, topic, value, room, original) {
    const fact = profile.prepare('SELECT value,source_msg_id,source_quote FROM personal_memory_fact WHERE account_id=? AND kind=? AND topic=?')
      .get(owner, kind, topic);
    assert.equal(fact?.value, value, topic);
    assert.ok(fact.source_quote && original.includes(fact.source_quote), topic);
    const turn = conversations.prepare('SELECT account_id,session_id,role,text FROM conversation WHERE id=?').get(fact.source_msg_id);
    assert.deepEqual({...turn}, {account_id: owner, session_id: room, role: 'user', text: original});
    return fact.source_msg_id;
  }
  try {
    const name = '青梧舵手';
    assert.match(await direct('我让你以后怎么称呼我？', 'verify-clean', 'memory'), /不记得/);
    const first = '请记住，以后叫我' + name + '。我不喜欢香菜，以后不要推荐。';
    const saved = await direct(first, 'verify-memory-a', 'memory_action', {body: {user: 'spoofed-owner'}});
    assert.match(saved, /记住.*青梧舵手.*不喜欢香菜/);
    assert.equal(profile.prepare('SELECT nickname FROM family_member WHERE account_id=?').get(owner)?.nickname, name);
    sourceFor('name', '称呼', name, 'verify-memory-a', first);
    const sourceId = sourceFor('preference', '香菜', '不喜欢', 'verify-memory-a', first);
    const getInjection = () => profile.prepare("SELECT last_injected_at FROM memory_item WHERE account_id=? AND source_msg_id=? AND status='active'")
      .get(owner, sourceId);
    const before = getInjection();
    assert.ok(before, 'preference has an active evidence row');
    const second = await direct('我让你以后怎么称呼我？我明确说过不喜欢哪种食材？', 'verify-memory-b', 'memory');
    assert.match(second, /青梧舵手/);
    assert.match(second, /不喜欢香菜/);
    assert.deepEqual(getInjection(), before, 'deterministic recall did not inject an LLM prompt');
    const unknown = await direct('你记得我的幸运颜色是什么吗？', 'verify-memory-b', 'memory');
    assert.match(unknown, /不记得/);
    assert.doesNotMatch(unknown, /青梧舵手|香菜/);

    const correction = '我以前不喜欢香菜，但现在已经喜欢上香菜了。';
    assert.match(await direct(correction, 'verify-memory-b', 'memory_action'), /记住.*喜欢香菜/);
    sourceFor('preference', '香菜', '喜欢', 'verify-memory-b', correction);
    const corrected = await direct('你记得我喜欢香菜吗？', 'verify-memory-c', 'memory');
    assert.match(corrected, /喜欢香菜/);
    assert.doesNotMatch(corrected, /不喜欢/);
    assert.match(await direct('把我喜欢香菜这件事忘掉', 'verify-memory-c', 'memory_action'), /移除/);
    assert.match(await direct('你记得我喜欢香菜吗？', 'verify-memory-d', 'memory'), /不记得/);
    assert.match(await direct('把我喜欢香菜这件事忘掉', 'verify-memory-d', 'memory_action'), /没有找到/);
    assert.match(await direct('我让你以后怎么称呼我？', 'verify-memory-d', 'memory'), /青梧舵手/);
    console.log('memory action receipts, original user evidence, correction and retraction across rooms passed');

    const transient = {body: {store: false}};
    const command = '你以后回答要简短一点。';
    assert.match(await direct(command, 'verify-style-a', 'style'), /以后.*简短/);
    assert.equal(template(), 'quiet');
    assert.ok(profile.prepare('SELECT 1 FROM growth_event WHERE account_id=? AND trigger_quote=?').get(owner, command));
    const styled = await chat('打个招呼，然后告诉我你能帮我做些什么。', 'verify-style-b');
    assert.equal(styled.tool, undefined);
    assert.ok(styled.text.length <= 115 && styled.text.split(/[。！？]+/u).filter(Boolean).length <= 2, 'quiet persona in real reply');

    const room = 'verify-style-once';
    assert.match(await direct('只这一次，说话幽默一点。', room, 'style'), /下一问.*幽默/);
    assert.match(await direct('以后都这样', room + '-other', 'style'), /想让我以后怎么说/);
    assert.match(await direct('伦敦现在几点？', room, 'clock'), /伦敦/);
    const answer = await chat('给我讲讲彩虹是怎么来的。', room);
    assert.equal(answer.tool, undefined);
    assert.equal(template(), 'quiet');
    assert.match(await direct('以后都这样', room, 'style'), /以后.*幽默/);
    assert.equal(template(), 'funny');

    assert.match(await direct('只这一次，简短点。', room, 'style'), /下一问.*简短/);
    assert.equal((await chat('给我讲讲海水为什么是咸的。', room)).tool, undefined);
    assert.equal((await chat('聊聊枫叶为什么会变红。', room)).tool, undefined);
    assert.match(await direct('以后都这样', room, 'style'), /想让我以后怎么说/);
    assert.equal(template(), 'funny');
    for (const [text, key] of [['以后多聊点', 'chatty'], ['以后简短些', 'quiet'], ['以后幽默些', 'funny'], ['以后恢复默认', 'default']]) {
      assert.match(await direct(text, 'verify-style-switch', 'style'), /以后/);
      assert.equal(template(), key);
    }
    assert.match(await direct('以后都简短点', 'verify-temporary', 'style', transient), /临时对话/);
    assert.equal(template(), 'default');
    console.log('temporary and persistent style, cross-room isolation, immediate switches and growth ledger passed');

    await chat('临时请求仅回复好的。', 'verify-temporary', transient);
    assert.equal(conversations.prepare("SELECT 1 FROM conversation WHERE session_id='verify-temporary'").get(), undefined);
    console.log('temporary conversation leaves no transcript');
  } finally {
    conversations.close();
    profile.close();
  }
}
