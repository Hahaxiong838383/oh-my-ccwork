/**
 * job_run 运维脚本（2026-09-03）。在 server 目录跑（DB 路径与服务同口径，先 `set -a; . ./.env.local; set +a`）：
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/job-run-ops.ts show [job]
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/job-run-ops.ts peek [nowISO]
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/job-run-ops.ts seed <day> <startedISO> <finishedISO> <note>
 * - show：列最近 30 天记录（默认 persona_daily）。
 * - peek：用真实 decideDailyRun 干跑（不认领），看此刻 tick 会做什么——上线后的生产探针。
 * - seed：把某天直接标成已完成。**上线当天必做**：否则部署重启后的第一个 tick 照样把当日批补跑一遍。
 */
import { jobRunStore } from '../src/job-run-store.js';
import { decideDailyRun, PERSONA_DAILY_JOB } from '../src/insight-runner.js';

const cst = (t: number | null | undefined): string =>
  typeof t === 'number' ? new Date(t + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') + ' CST' : '-';

const [cmd = 'show', ...rest] = process.argv.slice(2);

if (cmd === 'show') {
  const job = rest[0] || PERSONA_DAILY_JOB;
  const rows = jobRunStore.list(job, 30);
  console.log(`job=${job} rows=${rows.length}`);
  for (const r of rows) console.log(`${r.day}  started=${cst(r.started_at)}  finished=${cst(r.finished_at)}  pid=${r.pid ?? '-'}  note=${r.note}`);
} else if (cmd === 'peek') {
  const now = rest[0] ? Date.parse(rest[0]) : Date.now();
  if (!Number.isFinite(now)) { console.error('bad nowISO'); process.exit(2); }
  const d = decideDailyRun(now, true);
  const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const row = jobRunStore.get(PERSONA_DAILY_JOB, day);
  console.log(`now=${cst(now)} day=${day} decision=${d} row=${row ? `started=${cst(row.started_at)} finished=${cst(row.finished_at)} note=${row.note}` : 'none'}`);
} else if (cmd === 'seed') {
  const [day, startedIso, finishedIso, ...noteParts] = rest;
  const started = Date.parse(startedIso ?? ''), finished = Date.parse(finishedIso ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !Number.isFinite(started) || !Number.isFinite(finished) || !noteParts.length) {
    console.error('usage: seed <day> <startedISO> <finishedISO> <note>');
    process.exit(2);
  }
  jobRunStore.seedDone(PERSONA_DAILY_JOB, day, started, finished, noteParts.join(' '));
  const row = jobRunStore.get(PERSONA_DAILY_JOB, day);
  console.log(`seeded ${day}: started=${cst(row?.started_at)} finished=${cst(row?.finished_at)} note=${row?.note}`);
} else {
  console.error('unknown cmd', cmd);
  process.exit(2);
}
