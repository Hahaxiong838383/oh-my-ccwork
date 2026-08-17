/**
 * race-llm 单测（tsx 直跑，惯例同 expression-filter.test.ts）：
 * 五场景——快路胜透传+败者 abort / 一路挂另一路无感 / 双败单 onError /
 * 空流不抢胜 / 双空收尾 onDone('')。mock client 用可控延时模拟时序。
 */
import { createRaceLlmClient } from '../src/providers/race-llm.js';
import type { DeepseekLlmClient } from '../src/providers/deepseek-llm.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type MockPlan =
  | { kind: 'stream'; delayMs: number; chunks: string[] }
  | { kind: 'error'; delayMs: number; message: string }
  | { kind: 'empty'; delayMs: number };

function mockClient(plan: MockPlan): { client: DeepseekLlmClient; aborted: () => boolean } {
  let aborted = false;
  const client: DeepseekLlmClient = {
    async streamChat(opts) {
      await sleep(plan.delayMs);
      if (aborted) return;
      if (plan.kind === 'error') {
        opts.onError(new Error(plan.message));
        return;
      }
      if (plan.kind === 'empty') {
        opts.onDone('');
        return;
      }
      let full = '';
      for (const c of plan.chunks) {
        if (aborted) return;
        full += c;
        opts.onDelta(c);
        await sleep(5);
      }
      if (!aborted) opts.onDone(full);
    },
    abort() {
      aborted = true;
    },
  } as DeepseekLlmClient & { abort: () => void };
  return { client, aborted: () => aborted };
}

async function collect(
  main: MockPlan,
  fb: MockPlan,
): Promise<{ deltas: string[]; done: string | null; err: string | null; fbAborted: boolean; mainAborted: boolean }> {
  const m = mockClient(main);
  const f = mockClient(fb);
  const race = createRaceLlmClient(() => m.client, () => f.client);
  const deltas: string[] = [];
  let done: string | null = null;
  let err: string | null = null;
  await race.streamChat({
    systemPrompt: 's',
    userText: 'u',
    onDelta: (d) => deltas.push(d),
    onDone: (t) => {
      done = t;
    },
    onError: (e) => {
      err = e.message;
    },
  });
  return { deltas, done, err, fbAborted: f.aborted(), mainAborted: m.aborted() };
}

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}`);
  }
}

async function run(): Promise<void> {
  // 1. main 快 → main 胜全量透传，fb 被 abort
  let r = await collect(
    { kind: 'stream', delayMs: 10, chunks: ['你好', '呀'] },
    { kind: 'stream', delayMs: 60, chunks: ['我是兜底'] },
  );
  assert(r.deltas.join('') === '你好呀' && r.done === '你好呀', 'main 快则 main 胜且全量透传');
  assert(r.fbAborted, '败者 fb 被 abort');

  // 2. fb 快 → fb 胜（won_by=fallback 不是故障）
  r = await collect(
    { kind: 'stream', delayMs: 80, chunks: ['慢主路'] },
    { kind: 'stream', delayMs: 10, chunks: ['快兜底'] },
  );
  assert(r.deltas.join('') === '快兜底' && r.done === '快兜底', 'fb 快则 fb 胜');
  assert(r.mainAborted, '败者 main 被 abort');

  // 3. main 挂 fb 正常 → 无感接管，零 onError
  r = await collect(
    { kind: 'error', delayMs: 5, message: 'main down' },
    { kind: 'stream', delayMs: 30, chunks: ['兜底接管'] },
  );
  assert(r.deltas.join('') === '兜底接管' && r.err === null, '单路挂另一路无感接管');

  // 4. 双路全败 → 恰一次 onError
  r = await collect(
    { kind: 'error', delayMs: 5, message: 'a' },
    { kind: 'error', delayMs: 10, message: 'b' },
  );
  assert(r.err !== null && r.done === null && r.deltas.length === 0, '双败单次 onError');

  // 5. 一路空流一路正常 → 空流不抢胜，正常路胜出
  r = await collect(
    { kind: 'empty', delayMs: 5 },
    { kind: 'stream', delayMs: 30, chunks: ['正文'] },
  );
  assert(r.deltas.join('') === '正文' && r.done === '正文', '空流不抢胜');

  // 6. 双空 → onDone("") 收尾不悬挂
  r = await collect({ kind: 'empty', delayMs: 5 }, { kind: 'empty', delayMs: 8 });
  assert(r.done === '' && r.err === null, '双空以 onDone("") 收尾');

  console.log(process.exitCode ? 'FAILED' : 'ALL PASS');
}

void run();
