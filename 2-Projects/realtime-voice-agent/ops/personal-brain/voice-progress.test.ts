import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isVoiceCompletion, withVoiceProgress } from './voice-progress.js';

const windows = {chatWaitMs: 15, searchWaitMs: 5};
const signal = () => new AbortController().signal;
const testRoom = 'pv-' + 'a'.repeat(32);

test('only worker streaming room IDs receive spoken progress', () => {
  assert.ok(isVoiceCompletion(testRoom, false));
  assert.ok(!isVoiceCompletion(testRoom, true));
  for (const room of [undefined, 'diagnostic', 'pv-1234', testRoom + 'x']) {
    assert.ok(!isVoiceCompletion(room, false));
  }
});
test('quick tool and chat replies pass through without a preface or a timer delay', async () => {
  for (const body of ['北京时间七点。', '清晨我们一起出门，', '好的。']) {
    const out: string[] = [];
    const result = await withVoiceProgress(testRoom, async (say, lookup) => {
      lookup();
      await say(body);
      if (body.length >= 6) assert.deepEqual(out, [body]);
      return body;
    }, async s => { out.push(s); }, signal(), windows);
    await delay(20);
    assert.equal(result, body);
    assert.deepEqual(out, [body]);
  }
});
test('while looking up, one stand-alone sentence precedes slow body; stored answer stays clean', async () => {
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    const out: string[] = [];
    const body = '我找到了两条来源。';
    const result = await withVoiceProgress(testRoom, async (say, lookup) => {
      lookup();
      await delay(25);
      assert.equal(out.length, 1);
      assert.ok(Array.from(out[0]).length >= 6 && out[0].endsWith('。'));
      assert.ok(!seen.has(out[0]));
      seen.add(out[0]);
      await say(body);
      return body;
    }, async s => { out.push(s); }, signal(), windows);
    assert.equal(result, body);
    assert.equal(out.length, 2);
    assert.equal(out[1], body);
  }
});
test('a delayed incomplete model token cannot suppress the first audible sentence, or reorder writes', async () => {
  const out: string[] = [];
  await withVoiceProgress(testRoom, async say => {
    await say('肥');
    await delay(40);
    await say('皂泡会反光。');
  }, async s => { await delay(1); out.push(s); }, signal(), windows);
  assert.equal(out.length, 3);
  assert.ok(out[0].endsWith('。') && Array.from(out[0]).length >= 6);
  assert.equal(out.slice(1).join(''), '肥皂泡会反光。');
  // Repeated slow ordinary turns within the cooldown go straight to the answer.
  const next: string[] = [];
  await withVoiceProgress(testRoom, async say => { await delay(25); await say('是薄膜干涉。'); }, async s => { next.push(s); }, signal(), windows);
  assert.deepEqual(next, ['是薄膜干涉。']);
});
test('simultaneous slow chats on separate devices each get one cue and keep independent cooldowns', async () => {
  const rooms = ['b', 'c'].map(byte => 'pv-' + byte.repeat(32));
  async function question(room: string) {
    const out: string[] = [];
    await withVoiceProgress(room, async say => {
      await delay(30);
      await say('这次已经想好了。');
    }, async s => { out.push(s); }, signal(), windows);
    return out;
  }
  const first = await Promise.all(rooms.map(question));
  for (const chunks of first) {
    assert.equal(chunks.length, 2);
    assert.equal(chunks[1], '这次已经想好了。');
  }
  const repeated = await Promise.all(rooms.map(question));
  assert.deepEqual(repeated, [['这次已经想好了。'], ['这次已经想好了。']]);
});
test('interrupting before and after acknowledgement never writes late audio', async () => {
  for (const wait of [0, 25]) {
    const controller = new AbortController();
    const out: string[] = [];
    const run = withVoiceProgress(testRoom, async (say, lookup) => {
      lookup();
      await delay(60, undefined, {signal: controller.signal});
      await say('过期的答复。');
    }, async s => { out.push(s); }, controller.signal, windows);
    if (wait) await delay(wait);
    controller.abort();
    await assert.rejects(run, {name: 'AbortError'});
    await delay(15);
    assert.equal(out.length, Number(wait > 0));
    assert.ok(!out.includes('过期的答复。'));
  }
});
