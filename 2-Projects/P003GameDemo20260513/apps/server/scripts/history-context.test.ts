// P0.1 会话多轮 history 单测：验证 history 正确进入 LLM 请求 messages（顺序 system→历史→本轮 user），
// 以及无 history 时退化为单轮（向后兼容，不破坏现有调用）。
// 跑法：cd apps/server && ./node_modules/.bin/tsx scripts/history-context.test.ts
import assert from 'node:assert';

process.env.GEMINI_PROXY_URL = 'http://mock-proxy';
process.env.GEMINI_API_KEY = 'mock-key';

const { createGeminiLlmClient } = await import('../src/providers/gemini-llm.js');
const { createDeepseekLlmClient } = await import('../src/providers/deepseek-llm.js');
process.env.DEEPSEEK_API_KEY = 'mock-key';

// 一个最小 SSE 流：一句正文 + 末尾带 usage 的 chunk + [DONE]
const SSE =
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
  'data: [DONE]\n\n';

function installMockFetch(): () => any {
  let captured: any = null;
  globalThis.fetch = (async (_url: any, opts: any) => {
    captured = JSON.parse(opts.body);
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  return () => captured;
}

async function callGemini(history?: { role: 'user' | 'assistant'; content: string }[]) {
  const getBody = installMockFetch();
  const client = createGeminiLlmClient();
  let err: Error | null = null;
  await client.streamChat({
    systemPrompt: 'SYS',
    userText: '第二句',
    history,
    onDelta: () => {},
    onDone: () => {},
    onError: (e) => { err = e; },
  });
  if (err) throw err;
  return getBody();
}

async function callDeepseek(history?: { role: 'user' | 'assistant'; content: string }[]) {
  const getBody = installMockFetch();
  const client = createDeepseekLlmClient();
  let err: Error | null = null;
  await client.streamChat({
    systemPrompt: 'SYS',
    userText: '第二句',
    history,
    onDelta: () => {},
    onDone: () => {},
    onError: (e) => { err = e; },
  });
  if (err) throw err;
  return getBody();
}

// case 1: Gemini 带 history → system + 历史(2) + 本轮 user = 4 条，顺序正确
{
  const body = await callGemini([
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '答一' },
  ]);
  const m = body.messages;
  assert.equal(m.length, 4, `期望 4 条(system+2历史+user)，实际 ${m.length}`);
  assert.equal(m[0].role, 'system');
  assert.equal(m[1].role, 'user');
  assert.equal(m[1].content, '第一句');
  assert.equal(m[2].role, 'assistant');
  assert.equal(m[2].content, '答一');
  assert.equal(m[3].role, 'user');
  assert.equal(m[3].content, '第二句');
  console.log('✅ case1 Gemini 带 history：messages 顺序 system→历史→本轮 user 正确');
}

// case 2: Gemini 无 history → 退化单轮(system+user=2)，向后兼容
{
  const body = await callGemini(undefined);
  const m = body.messages;
  assert.equal(m.length, 2, `期望 2 条(system+user)，实际 ${m.length}`);
  assert.equal(m[0].role, 'system');
  assert.equal(m[1].content, '第二句');
  console.log('✅ case2 Gemini 无 history：退化单轮，向后兼容');
}

// case 3: DeepSeek 带 history 同样生效
{
  const body = await callDeepseek([
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '答一' },
  ]);
  const m = body.messages;
  assert.equal(m.length, 4, `期望 4 条，实际 ${m.length}`);
  assert.equal(m[1].content, '第一句');
  assert.equal(m[3].content, '第二句');
  console.log('✅ case3 DeepSeek 带 history：messages 正确');
}

console.log('\n🎉 P0.1 history→messages 全部通过');
