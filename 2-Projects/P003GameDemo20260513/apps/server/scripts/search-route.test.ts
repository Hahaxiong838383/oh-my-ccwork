import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchRoute } from '../src/routes/search-tasks.js';
import { SearchTasks } from '../src/tools/search-tasks.js';
import { Hono } from 'hono';

test('HTTP接单、查询、领取、回执闭环；拒绝未授权/阶段伪造/超大及额外字段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-http-'));
  const owner = { subject: 'BJP00326070803800006', session: 'sn-BJP00326070803800006-1' };
  let calls = 0;
  const tasks = new SearchTasks({ dbPath: join(dir, 'db'), enabled: () => true, allowed: s => s === owner.subject,
    execute: async () => { calls++; return { text: '刚才没有找到可靠资料。', sources: [] }; } });
  const app = createSearchRoute({ owner: async c => c.req.header('authorization') === 'Bearer synthetic-worker' ? owner : null, tasks: () => tasks });
  const req = (path: string, body?: unknown, auth = true) => app.request(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(auth ? { authorization: 'Bearer synthetic-worker' } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const input = { turn: '1', query: '科技馆开放时间', phase: 'committed', protocol: 1 };
  try {
    assert.equal((await req('/', input, false)).status, 401);
    assert.equal((await req('/', { ...input, phase: 'speculative' })).status, 400);
    assert.equal((await req('/', { ...input, account_id: 'forged' })).status, 400);
    assert.equal((await req('/', { ...input, query: 'x'.repeat(10000) })).status, 413);
    assert.equal(calls, 0);
    const response = await req('/', input); assert.equal(response.status, 202);
    const { task } = await response.json() as any;
    await new Promise(r => setImmediate(r));
    const poll = await (await req('/')).json() as any; assert.equal(poll.tasks.length, 1);
    assert.equal(poll.tasks[0].subject, undefined, '响应不额外暴露设备身份');
    assert.equal((await req('/' + task.id + '/claim', { delivery: 'd1' })).status, 200);
    assert.equal((await req('/' + task.id + '/receipt', { delivery: 'd1', outcome: 'completed' })).status, 200);
    assert.equal(((await (await req('/')).json()) as any).tasks.length, 0);
    assert.equal((await req('/session/cancel', {})).status, 200);
    assert.equal((await req('/', { ...input, turn: '2' })).status, 409);
  } finally { tasks.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('功能关闭不创建账本，不改变普通chat路由', async () => {
  let gets = 0;
  const app = new Hono();
  app.route('/v1/internal/search-tasks', createSearchRoute({ owner: async () => null, tasks: () => { gets++; return null; } }));
  app.post('/v1/chat/completions', c => c.text('ordinary-chat'));
  assert.equal((await app.request('/v1/internal/search-tasks')).status, 401);
  assert.equal(gets, 0);
  assert.equal(await (await app.request('/v1/chat/completions', { method: 'POST' })).text(), 'ordinary-chat');
});

test('共享v1合同夹具能通过HTTP接单并回传Worker所需字段',async()=>{
 const owner={subject:'BJP00326070803800006',session:'sn-BJP00326070803800006-1'};
 const {readFileSync}=await import('node:fs');
 const fixture=JSON.parse(readFileSync(new URL('../../../../../4-Assets/contracts/p003-search-task-v1.json',import.meta.url),'utf8'));
 const dir=mkdtempSync(join(tmpdir(),'search-contract-'));
 const tasks=new SearchTasks({dbPath:join(dir,'tasks.db'),enabled:()=>true,allowed:()=>true,execute:async()=>fixture.ready.result});
 const route=createSearchRoute({owner:async()=>owner,tasks:()=>tasks});
 try{
  const response=await route.request('/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture.submit)});
  assert.equal(response.status,202);await new Promise(r=>setImmediate(r));
  const body=await(await route.request('/')).json() as any;
  for(const key of Object.keys(fixture.ready))assert.ok(key in body.tasks[0],key);
  assert.ok(body.tasks[0].valid_for_ms>0&&body.tasks[0].valid_for_ms<=fixture.limits.ready_ttl_ms);
  assert.equal(body.tasks[0].result.text,fixture.ready.result.text);
 }finally{tasks.close();rmSync(dir,{recursive:true,force:true});}
});
