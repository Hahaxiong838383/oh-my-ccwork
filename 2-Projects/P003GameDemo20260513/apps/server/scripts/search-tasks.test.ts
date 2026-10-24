import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchTasks, type SearchResult } from '../src/tools/search-tasks.js';

const owner = { subject: 'BJP00326070803800006', session: 'sn-BJP00326070803800006-1' };
const result: SearchResult = { text: '刚才查的开放安排，官网没有说明本周临时调整，请再核对当天公告。', sources: [{ title: '开放安排', url: 'https://www.cstm.org.cn/open', date: null }] };
const flush = () => new Promise<void>(r => setImmediate(r));

test('R15 delivery completed does not turn a failure or empty evidence into a successful answer', async () => {
  for (const kind of ['answer', 'empty', 'invalid', 'unknown'] as const) {
    const f = fixture(async () => {
      if (kind === 'invalid') throw new Error('invalid_answer');
      if (kind === 'unknown') throw new Error('https://private.invalid/?token=DO_NOT_LOG');
      return kind === 'empty' ? { text: '这次没有找到可靠的资料。', sources: [] } : result;
    });
    try {
      const t = f.tasks.submit(owner, request()); await flush();
      f.tasks.claim(owner, t.id, 'delivery'); f.tasks.receipt(owner, t.id, 'delivery', 'completed');
      const a: any = f.tasks.audit()[0];
      assert.equal(a.delivery, 'completed');
      assert.equal(a.outcome, kind === 'answer' ? 'answered' : kind === 'empty' ? 'no_evidence' : 'failed');
      if (kind === 'invalid') assert.deepEqual(a.failure, {stage: 'answer', reason: 'invalid_answer'});
      if (kind === 'unknown') assert.deepEqual(a.failure, {stage: 'task', reason: 'unknown'});
      assert.doesNotMatch(readFileSync(f.dbPath).toString(), /DO_NOT_LOG|private\.invalid/);
    } finally { f.close(); }
  }
});
test('R5 replay uses distinct idempotent claims, one automatic retry and immutable deadlines', async () => {
  const f = fixture(async () => result);
  try {
    const a = f.tasks.submit(owner, request()); await flush();
    f.tasks.claim(owner, a.id, 'first'); f.tasks.receipt(owner, a.id, 'first', 'interrupted');
    const retry = f.tasks.replay(owner, a.id, 'first', 'second', true);
    assert.equal(retry.claim, 'second'); assert.equal(retry.delivery, 'claimed');
    assert.equal(f.tasks.replay(owner, a.id, 'first', 'second', true).claim, 'second');
    assert.throws(() => f.tasks.receipt(owner, a.id, 'first', 'completed'), /claim_mismatch/);
    f.tasks.receipt(owner, a.id, 'second', 'interrupted');
    assert.throws(() => f.tasks.replay(owner, a.id, 'second', 'third', true), /not_ready/);
    f.advance(60_000);
    const manual = f.tasks.replay(owner, a.id, 'second', 'third', false);
    assert.equal(manual.readyAt, retry.readyAt);
    f.tasks.receipt(owner, a.id, 'third', 'completed'); f.advance(240_000);
    assert.throws(() => f.tasks.replay(owner, a.id, 'third', 'fourth', false), /not_ready/);
  } finally { f.close(); }
});
test('R5 automatic replay cannot resurrect expired, cancelled, disabled or foreign tasks', async () => {
 for (const action of ['timeout','cancel','disable','foreign'] as const) {
  const f=fixture(async()=>result);
  try {
   const a=f.tasks.submit(owner,request()); await flush();
   f.tasks.claim(owner,a.id,'first'); f.tasks.receipt(owner,a.id,'first','interrupted');
   if(action==='timeout') f.advance(60_000);
   if(action==='cancel') f.tasks.cancelSession(owner);
   if(action==='disable') f.disable();
   assert.throws(()=>f.tasks.replay(action==='foreign'?{...owner,session:owner.session+'x'}:owner,a.id,'first','second',true), /not_ready|disabled|not_found/);
  } finally {f.close();}
 }
});
function fixture(execute: (q: string, s: AbortSignal) => Promise<SearchResult>, limits = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p003-search-'));
  let time = 1_800_000_000_000;
  let enabled = true;
  const dbPath = join(dir, 'tasks.db');
  const opts = { dbPath, execute, now: () => time, enabled: () => enabled,
    allowed: (s: string) => s === owner.subject, concurrency: 1, queueLimit: 2, ...limits };
  const tasks = new SearchTasks(opts);
  return { tasks, dbPath, opts, advance: (ms: number) => { time += ms; tasks.tick(); },
    disable: () => { enabled = false; tasks.tick(); },
    close: () => { tasks.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function request(turn = '1', query = '中国科学技术馆周末开放安排') {
  return { turn, query, phase: 'committed', protocol: 1 };
}

test('接单不等待网络；重复提交只执行一次；其他会话无法读取或领取', async () => {
  let release!: (r: SearchResult) => void; let calls = 0;
  const f = fixture(async () => { calls++; return new Promise(r => { release = r; }); });
  try {
    const a = f.tasks.submit(owner, request());
    assert.equal(a.status, 'running');
    assert.equal(f.tasks.submit(owner, request()).id, a.id);
    assert.equal(calls, 1);
    assert.throws(() => f.tasks.get({ ...owner, session: owner.session + '2' }, a.id), /not_found/);
    assert.throws(() => f.tasks.claim({ ...owner, subject: 'other' }, a.id, 'delivery-a'), /not_found/);
    release(result); await flush();
    assert.equal(f.tasks.get(owner, a.id).status, 'ready');
    const detached = f.tasks.list(owner)[0]; detached.status = 'cancelled'; detached.result!.text = 'tampered';
    assert.equal(f.tasks.get(owner, a.id).status, 'ready');
    assert.equal(f.tasks.get(owner, a.id).result!.text, result.text);
    assert.equal(f.tasks.claim(owner, a.id, 'delivery-a').result?.text, result.text);
    assert.equal(f.tasks.list(owner)[0].id, a.id, '领取后仍可轮询状态，关闸或取消能撤销待播结果');
    assert.throws(() => f.tasks.claim(owner, a.id, 'delivery-b'), /already_claimed/);
    f.tasks.receipt(owner, a.id, 'delivery-a', 'interrupted');
    assert.equal(f.tasks.get(owner, a.id).delivery, 'interrupted');
    assert.equal(f.tasks.list(owner).length, 0, '已播或打断的结果不再主动返回');
  } finally { f.close(); }
});

test('普通聊天不改变后台任务；明确取消拒绝迟到结果且不释放未结束的执行槽', async () => {
  let release!: (r: SearchResult) => void; let signal!: AbortSignal;
  const f = fixture(async (_q, s) => { signal = s; return new Promise(r => { release = r; }); });
  try {
    const a = f.tasks.submit(owner, request());
    const b = f.tasks.submit(owner, request('2', '故宫博物院开放安排'));
    assert.equal(b.status, 'queued');
    assert.equal(f.tasks.get(owner, a.id).status, 'running');
    f.tasks.cancel(owner, a.id);
    assert.equal(signal.aborted, true);
    assert.equal(f.tasks.get(owner, b.id).status, 'queued');
    release(result); await flush();
    assert.equal(f.tasks.get(owner, a.id).status, 'cancelled');
    assert.equal(f.tasks.get(owner, a.id).result, undefined);
    assert.equal(f.tasks.get(owner, b.id).status, 'running');
  } finally { f.close(); }
});

test('投机/预热/未授权/敏感查询/满会话不产生外部执行', () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Promise(() => {}); });
  try {
    for (const phase of ['prewarm', 'speculative']) assert.throws(() => f.tasks.submit(owner, { ...request(), phase }), /invalid_request/);
    assert.throws(() => f.tasks.submit({ ...owner, subject: 'other' }, request()), /disabled/);
    assert.throws(() => f.tasks.submit(owner, request('1', '我的学校和家庭住址')), /private_query/);
    assert.equal(calls, 0);
    f.tasks.submit(owner, request()); f.tasks.submit(owner, request('2'));
    assert.throws(() => f.tasks.submit(owner, request('3')), /queue_full/);
    assert.equal(calls, 1);
  } finally { f.close(); }
});

test('期限包含排队；关闸取消执行与待播；退出墓碑阻止迟到提交', async () => {
  const f = fixture(async () => result);
  try {
    const a = f.tasks.submit(owner, request()); await flush();
    f.disable();
    assert.equal(f.tasks.get(owner, a.id).status, 'cancelled');
    assert.throws(() => f.tasks.claim(owner, a.id, 'a'), /not_ready/);
    assert.throws(() => f.tasks.submit(owner, request('2')), /disabled/);
  } finally { f.close(); }
  const g = fixture(async () => new Promise(() => {}));
  try {
    const a = g.tasks.submit(owner, request());
    const b = g.tasks.submit(owner, request('2'));
    g.advance(20_001);
    assert.equal(g.tasks.get(owner, a.id).status, 'expired');
    assert.equal(g.tasks.get(owner, b.id).status, 'expired');
    g.tasks.cancelSession(owner);
    assert.throws(() => g.tasks.submit(owner, request('3')), /session_closed/);
  } finally { g.close(); }
});

test('重启不重放网络任务；幂等账本保留；查询正文不落盘', () => {
  const f = fixture(async () => new Promise(() => {}));
  const a = f.tasks.submit(owner, request());
  f.tasks.close();
  const reopened = new SearchTasks(f.opts);
  try {
    assert.equal(reopened.get(owner, a.id).status, 'failed');
    assert.equal(reopened.submit(owner, request()).id, a.id);
    assert.equal(readFileSync(f.dbPath).includes(Buffer.from(request().query)), false);
  } finally { reopened.close(); f.close(); }
});

test('ready过期不再领取，实际回执必须匹配领取者', async () => {
  const f = fixture(async () => result);
  try {
    const a = f.tasks.submit(owner, request()); await flush();
    assert.throws(() => f.tasks.receipt(owner, a.id, 'not-claimed', 'completed'), /claim_mismatch/);
    f.advance(60_001);
    assert.equal(f.tasks.list(owner).length, 0);
    assert.throws(() => f.tasks.claim(owner, a.id, 'late'), /not_ready/);
  } finally { f.close(); }
});

test('持久日配额与上游熔断只拦新单，已接单幂等查询仍可恢复', async()=>{
  let available=true;
  const f=fixture(async()=>result,{dailyDeviceLimit:1,canSubmit:()=>available});
  try{
    const a=f.tasks.submit(owner,request());await flush();
    available=false;
    assert.equal(f.tasks.submit(owner,request()).id,a.id);
    assert.throws(()=>f.tasks.submit(owner,request('2')),/upstream_paused/);
    available=true;
    assert.throws(()=>f.tasks.submit(owner,request('2')),/daily_limit/);
    f.tasks.close();
    const reopened=new SearchTasks(f.opts);
    try{assert.equal(reopened.submit(owner,request()).id,a.id);assert.throws(()=>reopened.submit(owner,request('2')),/daily_limit/);}finally{reopened.close();}
  }finally{f.close();}
});

test('R7 route version is frozen at admission and retries do not re-resolve it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'routing-task-'));let enabled=false,calls=0;
 const t=new SearchTasks({dbPath:join(dir,'tasks.db'),enabled:()=>true,allowed:()=>true,resolveRouting:()=>{calls++;return {version:'old',rule_id:'natural-weather',weather_enabled:enabled};},execute:async()=>result} as any);
 try {const input={...request('r7'),routing:{version:'old',rule_id:'natural-weather'}};
  const a=t.submit(owner,input as any);assert.equal((a as any).routing.weather_enabled,false);enabled=true;
  assert.equal(t.submit(owner,input as any).id,a.id);assert.equal(calls,1);assert.equal((t.get(owner,a.id) as any).routing.weather_enabled,false);
 }finally{t.close();rmSync(dir,{recursive:true,force:true});}
});
