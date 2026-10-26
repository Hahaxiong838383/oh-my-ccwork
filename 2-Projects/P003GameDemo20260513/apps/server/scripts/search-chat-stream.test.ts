import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';

const dir = mkdtempSync(join(tmpdir(), 'r17-chat-stream-'));
const previousCwd = process.cwd();
process.chdir(dir);
for (const name of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK','LOCAL_AUDIO','RELATION_STATE']) {
  process.env[name + '_DB_PATH'] = join(dir, name + '.db');
}
Object.assign(process.env, { AUTH_JWT_SECRET:'synthetic-secret', SEARCH_WORKER_ACCOUNT_ID:'worker',
  SEARCH_CANARY_ROOT:dir, SEARCH_TASK_DB_PATH:join(dir,'search.db'), SEARCH_ENABLED:'1',
  SEARCH_ALLOWED_DOMAINS:'cstm.org.cn', DEEPSEEK_API_KEY:'synthetic', LLM_PROVIDER:'deepseek', MEMORY_EXTRACT_ENABLED:'0' });
const first = '烤箱温度要看食谱，';
const last = '再按说明书设置。';
let releaseTail = () => {};
let tailReleased = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url) => {
  assert.ok(String(url).endsWith('/chat/completions'), 'unexpected network call');
  const encoder = new TextEncoder();
  const delta = (text: string) => encoder.encode('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\n');
  const body = new ReadableStream<Uint8Array>({start(controller) {
    controller.enqueue(delta(first));
    releaseTail = () => {
      if (tailReleased) return;
      tailReleased = true;
      controller.enqueue(delta(last));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    };
  }});
  return new Response(body, {headers:{'content-type':'text/event-stream'}});
}) as typeof fetch;
const { configStore } = await import('../src/config-store.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { closeSearchRuntime, searchSettings } = await import('../src/tools/search-runtime.js');
const { customLlmRoute } = await import('../src/routes/custom-llm.js');
const sn = 'BJP00326060100100004', room = `sn-${sn}-1`;
deviceRegistryStore.add(sn, 'test'); deviceRegistryStore.setAccountId(sn, 'device-A');
configStore.setFlag('p003.search.allowlist', JSON.stringify([sn]), 'test');
configStore.setFlag('p003.search.enabled', '1', 'test');
configStore.setFlag('p003.search.canary.expires_at_ms', String(Date.now()+60000), 'test');
assert.equal(searchSettings().enabled, true, 'fixture must enable the real candidate claim guard');

test('R17 real CustomLLM SSE forwards a safe temperature clause before upstream finishes its sentence', async () => {
  const originalInfo = console.info;
  const timings: Record<string, unknown>[] = [];
  console.info = (...args: unknown[]) => {
    if (args[0] === '[search-chat-timing]') timings.push(JSON.parse(String(args[1])));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'})
      .setIssuer('p003').setAudience('kidshub').setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
    const response = await customLlmRoute.request(`/chat/completions?room=${room}&token=${token}`, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({messages:[{role:'user',content:'烤箱的温度怎么调'}]}),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder(); let pending = '', all = '';
    const readFirstContent = async () => {
      while (true) {
        const next = await reader.read(); assert.ok(!next.done, 'missing first content');
        const chunk = decoder.decode(next.value, {stream:true}); pending += chunk; all += chunk;
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = event.split('\n').find(line => line.startsWith('data:'))?.slice(5).trim();
          if (data && data !== '[DONE]') {
            const content = JSON.parse(data).choices?.[0]?.delta?.content;
            if (content) return content;
          }
        }
      }
    };
    const content = await Promise.race([readFirstContent(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('safe content held until upstream sentence completion')), 1000);
    })]);
    clearTimeout(timer);
    assert.equal(content, first);
    assert.equal(tailReleased, false, 'no full-sentence input was available');
    assert.equal(timings.length, 1);
    assert.equal(timings[0].claim_guard_enabled, true);
    assert.equal(timings[0].room, room);
    for (const field of ['before_model_ms','upstream_first_delta_ms','output_filter_hold_ms','first_content_enqueued_ms']) {
      assert.ok(Number.isFinite(timings[0][field]) && Number(timings[0][field]) >= 0, field);
    }
    assert.ok(!JSON.stringify(timings).includes(first) && !JSON.stringify(timings).includes(token));
    releaseTail();
    while (true) { const next = await reader.read(); if (next.done) break; all += decoder.decode(next.value, {stream:true}); }
    assert.ok(all.includes(first) && all.includes(last) && all.includes('[DONE]'));
    assert.equal(timings.length, 1, 'only the first substantive content is timed');
  } finally {
    clearTimeout(timer); releaseTail(); console.info = originalInfo;
    globalThis.fetch = originalFetch; closeSearchRuntime(); process.chdir(previousCwd);
    rmSync(dir, {recursive:true, force:true});
  }
});
