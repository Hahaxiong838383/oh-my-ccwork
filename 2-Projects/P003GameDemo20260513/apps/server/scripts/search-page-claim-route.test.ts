import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';

const dir = mkdtempSync(join(tmpdir(), 'r27-page-claim-'));
const previousCwd = process.cwd();
process.chdir(dir);
for (const name of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK','LOCAL_AUDIO','RELATION_STATE']) {
  process.env[name + '_DB_PATH'] = join(dir, name + '.db');
}
Object.assign(process.env, { AUTH_JWT_SECRET:'synthetic-secret', SEARCH_WORKER_ACCOUNT_ID:'worker',
  SEARCH_CANARY_ROOT:dir, SEARCH_TASK_DB_PATH:join(dir,'search.db'), SEARCH_ENABLED:'1',
  SEARCH_ALLOWED_DOMAINS:'cstm.org.cn', DEEPSEEK_API_KEY:'synthetic', LLM_PROVIDER:'deepseek', MEMORY_EXTRACT_ENABLED:'0' });
let answer = '';
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url) => {
  assert.ok(String(url).endsWith('/chat/completions'), 'unexpected network call');
  const encoder = new TextEncoder();
  const delta = (text: string) => encoder.encode('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\n');
  const body = new ReadableStream<Uint8Array>({start(controller) {
    controller.enqueue(delta(answer));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
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

test('R27 page guard blocks uncreated queries without rewriting ordinary page conversation', async () => {
  const originalInfo=console.info;const timings:Record<string,unknown>[]=[];
  console.info=(...args:unknown[])=>{if(args[0]==='[search-chat-timing]')timings.push(JSON.parse(String(args[1])));};
  try {
    const token=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('5m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
    const cases = [
      {input:'帮我读一下央视往国内新闻页面挑一条能核实日期的新闻讲两句重点告诉我来源',guard:true,answer:'我帮你查一下央视新闻页面上的最新消息，稍等一下哦。'},
      {input:'网站是什么',guard:false,answer:'我来帮你看看，网站就是许多互相链接的网页。'},
      {input:'这个页面打不开',guard:false,answer:'我来帮你看看，可能是网络没有连接好。'},
      {input:'不要打开网页，我们聊小猫',guard:false,answer:'好呀，小猫喜欢躺在暖暖的地方。'},
    ];
    for (const c of cases) {
      timings.length=0;answer=c.answer;
      const response=await customLlmRoute.request(`/chat/completions?room=${room}&token=${token}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:c.input}]})});
      const result=await response.text();
      assert.equal(response.status,200);assert.equal(timings[0]?.claim_guard_enabled,c.guard,c.input);
      if(c.guard){assert.ok(!result.includes('我帮你查一下央视新闻'),result);assert.ok(result.includes('具体问题'),result);}
      else assert.ok(result.includes(c.answer),result);
    }
  } finally {console.info=originalInfo;globalThis.fetch=originalFetch;closeSearchRuntime();process.chdir(previousCwd);rmSync(dir,{recursive:true,force:true});}
});
