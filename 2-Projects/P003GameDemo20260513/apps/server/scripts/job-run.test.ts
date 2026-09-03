/**
 * job_run 每日批落库锁 · 回归测试（2026-09-03）。跑法：
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/job-run.test.ts
 * 覆盖：首次认领 / 租约内 busy / finish 后 done / 跨日重新认领 / 崩溃租约到期 reclaim /
 * seedDone / decideDailyRun 三档跳过与 dryRun 不落库 / 快照每日路径同日不覆盖、退回路径覆盖。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'job-run-test-'));
for (const k of ['PROFILE', 'DEVICES', 'CONVERSATION', 'CONFIG', 'ACCOUNTS', 'FEEDBACK', 'OTA', 'PAIRING', 'SMS', 'TELEMETRY']) {
  process.env[`${k}_DB_PATH`] = join(tmp, `${k.toLowerCase()}.db`);
}

const { jobRunStore, JOB_LEASE_MS, cstDayOf } = await import('../src/job-run-store.js');
const { decideDailyRun, PERSONA_DAILY_JOB } = await import('../src/insight-runner.js');
const { traitStore } = await import('../src/trait-store.js');

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1;
  else { fail += 1; console.error(`FAIL ${name} got=${g} want=${w}`); }
}

const H = 3600_000;
const T0 = new Date('2026-09-04T03:30:00+08:00').getTime();
const D0 = cstDayOf(T0);
eq('jr-0 沪时日期', D0, '2026-09-04');

// ---------- store 语义 ----------
const J = 'unit_job';
eq('jr-1 首次认领', jobRunStore.claim(J, D0, T0), 'claimed');
eq('jr-2 租约内再认领=busy', jobRunStore.claim(J, D0, T0 + 5 * 60_000), 'busy');
eq('jr-3 peek 租约内=busy', jobRunStore.peek(J, D0, T0 + 5 * 60_000), 'busy');
jobRunStore.finish(J, D0, T0 + 4 * 60_000);
eq('jr-4 finish 后=done', jobRunStore.claim(J, D0, T0 + H), 'done');
eq('jr-5 finish 后 peek=done', jobRunStore.peek(J, D0, T0 + H), 'done');
eq('jr-6 finished_at 落库', jobRunStore.get(J, D0)?.finished_at, T0 + 4 * 60_000);
eq('jr-7 跨日重新认领', jobRunStore.claim(J, cstDayOf(T0 + 24 * H), T0 + 24 * H), 'claimed');

// 崩溃租约：认领后进程死了（不 finish）
const D2 = '2026-09-10';
const T2 = new Date('2026-09-10T03:30:00+08:00').getTime();
eq('jr-8 认领', jobRunStore.claim(J, D2, T2), 'claimed');
eq('jr-9 租约差 1ms 仍 busy', jobRunStore.claim(J, D2, T2 + JOB_LEASE_MS - 1), 'busy');
eq('jr-10 租约到期 peek=reclaimed', jobRunStore.peek(J, D2, T2 + JOB_LEASE_MS), 'reclaimed');
eq('jr-11 租约到期 claim=reclaimed', jobRunStore.claim(J, D2, T2 + JOB_LEASE_MS), 'reclaimed');
eq('jr-12 重认领后 started_at 前移', jobRunStore.get(J, D2)?.started_at, T2 + JOB_LEASE_MS);
eq('jr-13 重认领后紧接着又是 busy', jobRunStore.claim(J, D2, T2 + JOB_LEASE_MS + 1), 'busy');
jobRunStore.finish(J, D2, T2 + JOB_LEASE_MS + 60_000);
eq('jr-14 补跑完成=done', jobRunStore.claim(J, D2, T2 + JOB_LEASE_MS + H), 'done');

// seedDone：运维直接标已完成
const D3 = '2026-09-11';
jobRunStore.seedDone(J, D3, 1, 2, 'seed:test');
eq('jr-15 seed 后=done', jobRunStore.claim(J, D3, new Date('2026-09-11T05:00:00+08:00').getTime()), 'done');
eq('jr-16 seed note 落库', jobRunStore.get(J, D3)?.note, 'seed:test');
eq('jr-17 list 按 day 倒序', jobRunStore.list(J, 10).map((r) => r.day), [D3, D2, cstDayOf(T0 + 24 * H), D0]);

// ---------- decideDailyRun（timer 决策） ----------
jobRunStore.clear(PERSONA_DAILY_JOB);
const T_EARLY = new Date('2026-09-05T01:00:00+08:00').getTime();
const T_DAY = new Date('2026-09-05T03:10:00+08:00').getTime();
eq('dd-1 沪时 <3 点=skip_hour(不认领)', decideDailyRun(T_EARLY), 'skip_hour');
eq('dd-2 <3 点没落库', jobRunStore.get(PERSONA_DAILY_JOB, '2026-09-05'), undefined);
eq('dd-3 dryRun 首次=run', decideDailyRun(T_DAY, true), 'run');
eq('dd-4 dryRun 不落库(再 dryRun 仍 run)', decideDailyRun(T_DAY, true), 'run');
eq('dd-5 真认领=run', decideDailyRun(T_DAY), 'run');
eq('dd-6 认领后未完成 下一 tick=skip_busy', decideDailyRun(T_DAY + H), 'skip_busy');
jobRunStore.finish(PERSONA_DAILY_JOB, '2026-09-05', T_DAY + 3 * 60_000);
eq('dd-7 完成后 重启补 tick=skip_done', decideDailyRun(T_DAY + 2 * H), 'skip_done');
eq('dd-8 完成后 dryRun=skip_done', decideDailyRun(T_DAY + 5 * H, true), 'skip_done');
eq('dd-9 次日 3 点档=run', decideDailyRun(T_DAY + 24 * H), 'run');
eq('dd-10 认领带 note=timer', jobRunStore.get(PERSONA_DAILY_JOB, '2026-09-06')?.note, 'timer');
eq('dd-11 崩溃后租约到期=run_reclaim', decideDailyRun(T_DAY + 24 * H + JOB_LEASE_MS), 'run_reclaim');

// ---------- 快照：每日路径同日不覆盖，退回路径覆盖 ----------
const AC = 'device-JOBRUNTEST0001';
const S1 = new Date('2026-09-05T03:41:00+08:00').getTime();
eq('sn-1 首份快照', traitStore.snapshotDaily(AC, S1), '2026-09-05');
eq('sn-2 同日再存(每日路径)不覆盖 created_at', (traitStore.snapshotDaily(AC, S1 + 17 * H), traitStore.listSnapshots(AC)[0]?.created_at), S1);
eq('sn-3 同日仍只一份', traitStore.listSnapshots(AC).length, 1);
eq('sn-4 overwrite 显式覆盖', (traitStore.snapshotDaily(AC, S1 + 18 * H, { overwrite: true }), traitStore.listSnapshots(AC)[0]?.created_at), S1 + 18 * H);
eq('sn-5 覆盖后仍只一份', traitStore.listSnapshots(AC).length, 1);

console.log(`job-run tests: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
