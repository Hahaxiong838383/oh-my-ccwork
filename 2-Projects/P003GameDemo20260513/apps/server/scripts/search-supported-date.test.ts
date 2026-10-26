import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchExecutor, type SearchValidationAudit } from '../src/tools/search-executor.js';

function scenario(query: string, source: string, drafts: string[][]) {
  let searches = 0;
  let calls = 0;
  const audit: SearchValidationAudit[] = [];
  const executor = new SearchExecutor({
    apiKey: 'synthetic', domains: ['example.org'], grounding: true,
    validationAudit: value => audit.push(value),
    fetch: (async (url: any) => {
      if (String(url).endsWith('/search')) {
        searches++;
        return Response.json({ results: [{ url: 'https://example.org/fixture',
          title: '合成历史资料', summary: source, snippet: source, date: null }] });
      }
      const texts = drafts[Math.min(calls++, drafts.length - 1)];
      const content = JSON.stringify({ abstain: false,
        claims: texts.map(text => ({ text, fact_ids: [1] })) });
      return new Response('data: ' + JSON.stringify({ choices: [{
        delta: { content }, finish_reason: 'stop',
      }] }) + '\n\ndata: [DONE]\n\n');
    }) as typeof fetch,
  });
  return { result: executor.run(query, AbortSignal.timeout(2000), ''), audit,
    counts: () => ({ searches, calls }) };
}

test('a supported extra historical date does not turn an answered name query into failure', async () => {
  for (const item of [
    { query: '中国第一颗卫星叫什么', source: '中国第一颗人造卫星东方红一号于1970年4月24日发射成功。',
      claims: ['它叫东方红一号。', '它在1970年4月24日发射成功。'] },
    { query: '这座合成展馆叫什么', source: '这座展馆叫蓝星馆，成立于1986年。',
      claims: ['它叫蓝星馆。', '它在1986年成立。'] },
  ]) {
    const run = scenario(item.query, item.source, [item.claims]);
    assert.equal((await run.result).text, item.claims.join(''));
    assert.deepEqual(run.counts(), { searches: 1, calls: 2 });
    assert.deepEqual(run.audit, []);
  }
});

test('a date absent from the cited fact still fails both candidate and review', async () => {
  const run = scenario('这座合成展馆叫什么', '这座展馆叫蓝星馆，成立于1986年。',
    [['它叫蓝星馆，1996年成立。']]);
  await assert.rejects(run.result, /invalid_grounding/);
  assert.deepEqual(run.counts(), { searches: 1, calls: 2 });
  assert.deepEqual(run.audit, [{ phase: 'review', codes: ['unquoted_number'] }]);
});

test('an invented review date cannot replace a valid answer', async () => {
  const run = scenario('这座合成展馆叫什么', '这座展馆叫蓝星馆，成立于1986年。',
    [['它叫蓝星馆。'], ['它叫蓝星馆，1996年成立。']]);
  const answer = await run.result;
  assert.equal(answer.text, '它叫蓝星馆。');
  assert.equal(answer.diagnostics?.answer_review_rejected, true);
  assert.deepEqual(run.audit, [{ phase: 'review', codes: ['unquoted_number'] }]);
  assert.deepEqual(run.counts(), { searches: 1, calls: 2 });
});

test('a supported explicitly requested date remains valid', async () => {
  const run = scenario('这座合成展馆哪年成立', '蓝星馆成立于1986年。', [['蓝星馆在1986年成立。']]);
  assert.equal((await run.result).text, '蓝星馆在1986年成立。');
  assert.deepEqual(run.audit, []);
});
