// Run against the released server bundle: node verify-story-feedback.mjs /path/to/context/server.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const bundle = resolve(process.argv[2] ?? new URL('./.build/context/server.mjs', import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), 'personal-feedback-test-'));
const owner = 'feedback-test';
const key = randomBytes(32).toString('hex');
Object.assign(process.env, {
  BRAIN_DATA_DIR: dir, BRAIN_OWNER_ID: owner, BRAIN_WORKER_KEY: key,
  BRAIN_UPSTREAM_BASE_URL: 'https://feedback.invalid/v1', BRAIN_UPSTREAM_API_KEY: 'fixture',
  BRAIN_UPSTREAM_MODEL: 'fixture', BRAIN_CPA_WEB_SEARCH: '0',
});
const nativeFetch = globalThis.fetch;
const originalListen = Server.prototype.listen;
let server;
Server.prototype.listen = function (options, ...args) {
  server = this;
  assert.equal(options,8080);
  return originalListen.call(this, 0, '127.0.0.1', ...args.slice(1));
};

const request = '请给我讲个故事。';
const story = '铅笔画了一扇门，橡皮从里面走了出来。';
const bear = '小熊摘下帽子，把藏在里面的小星星送回夜空。';
const explanation = '纸片平铺着，展开的面积大，受到的空气阻力也大。';
const generic = '我明白你的意思了。';
const long = '聊聊各种颜色吧。';
const prompts = [];
const extractionPrompts = [];
const ack = '谢谢，我很高兴你喜欢。';
const realInterest = '我每周都会收集邮票。';
globalThis.fetch = async (input, init) => {
  assert.equal(new URL(input).host, 'feedback.invalid');
  const body = JSON.parse(init.body);
  if (body.stream === false) {
    extractionPrompts.push(body.messages.at(-1).content);
    // Deliberately give *every* turn an enthusiastic score to provoke the old false positive.
    const interests = [
      {value:'这种讲法',evidence:'这种讲法我喜欢'},
      {value:'邮票',evidence:realInterest},
    ];
    return Response.json({choices:[{message:{content:JSON.stringify({turn_valence:0.9, turn_engagement:0.95, interests})}}]});
  }
  prompts.push(body.messages[0].content);
  const user = body.messages.at(-1).content;
  const output = user.includes('小熊的故事') ? bear : user.includes('给我讲个故事') ? story : user.includes('小纸片为什么') ? explanation
    : user.includes('各种颜色') ? '走在一条安静的小路上，每次回头都能看到不一样的云彩。'.repeat(6)
    : user.includes('需要更多线索') ? '你想听什么样的故事呢？' : generic;
  const chunk = JSON.stringify({choices:[{delta:{content:output}, finish_reason:'stop'}]});
  return new Response('data: '+chunk+'\n\ndata: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
};

let db;
try {
  await import(pathToFileURL(bundle).href);
  while (!server?.listening) await delay(5);
  const base = 'http://127.0.0.1:' + server.address().port;
  db = new DatabaseSync(join(dir,'profile.sqlite'));
  db.prepare('ATTACH DATABASE ? AS dialogs').run(join(dir, 'conversations.sqlite'));
  const rooms = ['1','2','3','4','5','6','7','8','9','a','b','c','d'].map(c => 'pv-'+c.repeat(32));
  async function say(room, text, store = true) {
    const response = await nativeFetch(base+'/v1/chat/completions', {
      method:'POST', headers:{authorization:'Bearer '+key, 'x-personal-session':room, 'content-type':'application/json'},
      body:JSON.stringify({stream:true, store, messages:[{role:'user', content:text}]}),
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert(sse.includes('[DONE]') && !sse.includes('"error"'));
    return sse;
  }
  function counts() {
    return ['explicit_story_feedback','explicit_style_feedback'].map(rule =>
      Number(db.prepare('SELECT count(*) AS n FROM growth_event WHERE rule=?').get(rule).n));
  }
  const confirmed = '这种讲法我喜欢。';
  const rated = '我喜欢你刚才讲的故事。';
  // Historical examples with no evidence must remain stored and absent from prompts.
  db.prepare("INSERT INTO style_pool(id,account_id,vector,child_said,xiaoke_did,mass,created_at,last_used_at) VALUES('old',?,'[0.9,0.95,1,1]','old request','old answer',2,1,1)").run(owner);
  await say(rooms[0],long);
  await say(rooms[1],'哈哈，太好了！我今天中奖啦。');
  await say(rooms[1],rated);
  await say(rooms[0],'今天真高兴，我升职了。');
  await say(rooms[2],request);
  await say(rooms[2],'太棒了！');
  for (const [i, text] of ['这种讲法我不喜欢。','这种讲法我喜欢吗？','我朋友喜欢这个故事。','我喜欢故事。'].entries()) {
    await say(rooms[3+i],request);
    await say(rooms[3+i],text);
  }
  await say(rooms[7],request);
  await say(rooms[7],'现在几点了？');
  assert(Number(db.prepare('SELECT count(*) AS n FROM dialogs.conversation WHERE session_id=? AND memory_excluded=1').get(rooms[7]).n)>=2);
  await say(rooms[7],confirmed);
  await say(rooms[8],request);
  await say(rooms[8],'记住，我的暗号是蓝水杯。');
  assert.equal(db.prepare('SELECT count(*) AS n FROM personal_memory_fact WHERE account_id=?').get(owner).n,1);
  await say(rooms[8],confirmed);
  await say(rooms[9],'讲个需要更多线索的故事吧。');
  await say(rooms[9],rated);
  assert.deepEqual(counts(),[0,0]);
  assert(!prompts.some(p=>p.includes('old answer')));
  assert(!db.prepare("SELECT 1 FROM growth_event WHERE rule IN ('reinforce_story_pos','reinforce_story_neg')").get());
  assert(extractionPrompts.length>0);
  assert(Number(db.prepare('SELECT valence_sample_count FROM relation_state WHERE account_id=?').get(owner).valence_sample_count)>0);

  // Simulate a partial write failure. Both the example and the trait must roll back.
  db.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON growth_event WHEN NEW.rule='explicit_story_feedback' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await say(rooms[10],request); await say(rooms[10],rated);
  assert.deepEqual(counts(),[0,0]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM style_pool').get().n,1);
  db.exec('DROP TRIGGER fixture_failure');
  // Equal text across two independent rooms is two approvals; repeated delivery with no new story is one.
  await Promise.all([say(rooms[0],request),say(rooms[1],request)]);
  db.prepare('UPDATE dialogs.conversation SET ts=ts-700000 WHERE session_id=?').run(rooms[1]);
  await Promise.all([say(rooms[0],rated),say(rooms[1],rated)]);
  assert.deepEqual(counts(),[2,2]);
  await say(rooms[1],rated);
  assert.deepEqual(counts(),[2,2]);
  await say(rooms[11],'小纸片为什么飘得慢？');
  await say(rooms[11],confirmed);
  assert.deepEqual(counts(),[2,3]);
  await say(rooms[12],'随便聊聊吧。');
  assert(prompts.at(-1).includes(explanation) && !prompts.at(-1).includes('old answer'));
  const evidence = db.prepare(`SELECT e.rule,s.xiaoke_did,s.child_said,
    r.text AS answer,f.text AS feedback,r.session_id AS rs,f.session_id AS fs,
    r.account_id AS ra,f.account_id AS fa,r.role AS rr,f.role AS fr
    FROM growth_event e JOIN dialogs.conversation r ON r.id=e.reply_msg_id
    JOIN dialogs.conversation f ON f.id=e.feedback_msg_id LEFT JOIN style_pool s ON s.id=e.id
    WHERE e.feedback_msg_id IS NOT NULL`).all();
  assert.equal(evidence.length,5);
  for (const row of evidence) {
    assert.equal(row.rs,row.fs); assert.equal(row.ra,owner); assert.equal(row.fa,owner);
    assert.equal(row.rr,'assistant'); assert.equal(row.fr,'user');
    assert.equal(row.answer,row.feedback===rated?story:explanation);
    if (row.rule==='explicit_style_feedback') {
      assert.equal(row.xiaoke_did,row.answer);
      assert.equal(row.child_said,row.feedback===rated?request:'小纸片为什么飘得慢？');
    }
  }
  const moves = db.prepare("SELECT from_val,to_val FROM growth_event WHERE rule='explicit_story_feedback' ORDER BY rowid").all();
  assert.equal(moves[0].to_val,moves[1].from_val);
  assert(Math.abs(+moves[1].to_val-Number(moves[0].from_val)-0.04)<1e-8);
  assert(Math.abs(Number(db.prepare('SELECT storytelling FROM trait_state WHERE account_id=?').get(owner).storytelling)-Number(moves[1].to_val))<1e-8);
  assert.equal(db.prepare("SELECT count(*) AS n FROM style_pool WHERE id='old'").get().n,1);
  await say(rooms[12],'忘记我的暗号。');
  assert.equal(db.prepare('SELECT count(*) AS n FROM personal_memory_fact WHERE account_id=?').get(owner).n,0);
  await say(rooms[12],'随便聊几句吧。');
  assert(prompts.at(-1).includes(explanation) && prompts.at(-1).includes('【过去有效的相处方式·参考】'), 'forgetting an unrelated fact must preserve the approved example');
  // A one-off style modifier excludes this turn from generic extraction but the
  // actual spoken reply can still be rated. Tool and style receipts are barriers.
  const styledRoom = rooms[2];
  const styledStory = '用一句话讲一个小熊的故事';
  assert((await say(styledRoom,styledStory)).includes(bear));
  const lastAssistant = () => db.prepare("SELECT id,text,memory_excluded,personal_feedback_reply FROM dialogs.conversation WHERE session_id=? AND role='assistant' ORDER BY ts DESC,rowid DESC LIMIT 1").get(styledRoom);
  const source = lastAssistant();
  assert.equal(source.text,bear);
  assert.deepEqual([source.memory_excluded,source.personal_feedback_reply],[1,1]);
  await say(styledRoom,confirmed);
  assert.deepEqual(counts(),[3,4]);
  assert.equal(db.prepare("SELECT reply_msg_id FROM growth_event WHERE rule='explicit_story_feedback' ORDER BY rowid DESC").get().reply_msg_id,source.id);
  await say(styledRoom,'随便说几句话。');
  assert(!extractionPrompts.at(-1).includes(styledStory) && !extractionPrompts.at(-1).includes(bear));
  for (const [command, result] of [
    ['用一句话告诉我现在几点了','clock'], ['用一句话查天气','weather'], ['只这一次，请用一句话回答','style'],
  ]) {
    await say(styledRoom,styledStory);
    const direct = await say(styledRoom,command);
    assert(direct.includes('"tool":"'+result+'"'), command);
    const receipt = lastAssistant();
    assert.deepEqual([receipt.memory_excluded,receipt.personal_feedback_reply],[1,0]);
    await say(styledRoom,confirmed);
    assert.deepEqual(counts(),[3,4]);
  }
  // Rows carried across an upgrade lack a verifiable reply classification.
  await say(styledRoom,styledStory);
  db.prepare('UPDATE dialogs.conversation SET personal_feedback_reply=0 WHERE id=?').run(lastAssistant().id);
  await say(styledRoom,confirmed);
  assert.deepEqual(counts(),[3,4]);
  // Explicit feedback is immediately audible, never sent to the chat or extraction
  // LLM, and remains addressable in the transcript. Even a faulty extractor that
  // volunteers a matching interest cannot turn the rating into an owner fact.
  const room = rooms[11];
  const countTurns = () => db.prepare('SELECT count(*) AS n FROM dialogs.conversation WHERE session_id=?').get(room).n;
  const interests = () => JSON.parse(db.prepare('SELECT interests FROM family_member WHERE account_id=?').get(owner).interests);
  await say(room,'记住，我喜欢吃蓝莓。');
  assert(interests().some(i=>i.value==='蓝莓' && i.state==='verified'));
  await say(room,request);
  const before = [prompts.length,extractionPrompts.length];
  const turnCount = countTurns();
  assert((await say(room,confirmed,false)).includes(ack));
  assert.equal(countTurns(),turnCount);
  assert((await say(room,confirmed)).includes(ack));
  assert.deepEqual([prompts.length,extractionPrompts.length],before);
  const pair = db.prepare('SELECT id,text,memory_excluded FROM dialogs.conversation WHERE session_id=? ORDER BY ts DESC,rowid DESC LIMIT 2').all(room);
  assert.deepEqual(pair.map(r=>[r.text,r.memory_excluded]), [[ack,1],[confirmed,1]]);
  assert(db.prepare("SELECT 1 FROM growth_event WHERE rule='explicit_style_feedback' AND feedback_msg_id=?").get(pair[1].id));
  await say(room,realInterest);
  assert(extractionPrompts.length>before[1]);
  assert(extractionPrompts.at(-1).includes(realInterest));
  assert(!extractionPrompts.at(-1).includes(confirmed) && !extractionPrompts.at(-1).includes(ack));
  assert(!interests().some(i=>i.value==='这种讲法'));
  assert(interests().some(i=>i.value==='蓝莓' && i.state==='verified') && interests().some(i=>i.value==='邮票'));
  // Simulate rows persisted by the previous release. No history rewrite is needed.
  db.prepare('UPDATE dialogs.conversation SET memory_excluded=0 WHERE id IN (?,?)').run(pair[0].id,pair[1].id);
  await say(room,'我们再继续聊聊。');
  assert(extractionPrompts.at(-1).includes('我们再继续聊聊。'));
  assert(!extractionPrompts.at(-1).includes(confirmed) && !extractionPrompts.at(-1).includes(ack));
  assert(!interests().some(i=>i.value==='这种讲法'));
  console.log('PASS: private production HTTP, negative/positive, prior evidence, concurrency, replay, failure rollback, relation and prompt');
} finally {
  globalThis.fetch = nativeFetch;
  Server.prototype.listen = originalListen;
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db?.close();
  rmSync(dir, {recursive:true, force:true});
}
