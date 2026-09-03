/**
 * 本地音频自然轮转对账表（给 codex 的 J-LA 证据，2026-09-03）。跑法(aliyun-hk)：
 *   cd /opt/p003/server && NODE_OPTIONS=--experimental-sqlite npx tsx scripts/la-reconcile.ts [YYYY-MM-DD]
 * 数据源：growth_event(module=local_audio) 的 commit 时刻 + local_audio_state + local_audio_fetch_log + local_audio_item。只读，SN 只打后四位。
 */
const day = process.argv[2] ?? new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const dayStart = new Date(`${day}T00:00:00+08:00`).getTime();
const { localAudioStore } = await import('../src/local-audio-store.js');
const { growthLedgerStore } = await import('../src/growth-ledger-store.js');
const { relationStateStore } = await import('../src/relation-state-store.js');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('data/profile.db', { readOnly: true });
const fmt = (t: number | null | undefined) => (t ? new Date(t + 8 * 3600e3).toISOString().slice(11, 19) : '—');
console.log(`| 设备 | gen commit(${day}) | 触发 | 新 revision | 首个新 manifest | 首个 applied | clips/bytes | 结果 |`);
console.log('|---|---|---|---:|---|---|---:|---|');
for (const a of relationStateStore.listAccounts().filter((x) => x.startsWith('device-'))) {
  const st = localAudioStore.getState(a) as { revision: number; last_generated_at: number };
  const commits = growthLedgerStore.list(a, { module: 'local_audio', limit: 200 }).filter((e) => e.ts >= dayStart);
  const commitTs = commits.length ? Math.min(...commits.map((e) => e.ts)) : 0;
  const trigger = commits[0]?.rule?.replace('local_audio:', '') ?? '—';
  const rev = st.revision;
  const log = localAudioStore.listFetchLog(a, commitTs || dayStart);
  const firstServed = commitTs ? log.find((r) => r.served_revision === rev)?.ts : undefined;
  const firstApplied = commitTs ? log.find((r) => r.applied === rev)?.ts : undefined;
  const agg = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM local_audio_item WHERE account_id = ? AND active = 1`).get(a) as { n: number; b: number };
  const result = !commitTs ? (commits.length ? '—' : '未触发') : firstApplied ? '✅ 已应用' : firstServed ? '⏳ 已发现未回报' : '⏳ 未发现';
  console.log(`| …${a.slice(-4)} | ${fmt(commitTs)} | ${trigger} | ${rev} | ${fmt(firstServed)} | ${fmt(firstApplied)} | ${agg.n}/${(agg.b / 1024).toFixed(0)}KiB | ${result} |`);
}
console.log(`\n口径：时刻=aliyun-hk 系统钟(沪时)；「首个新 manifest」=fetch_log 首次 served_revision==新 rev；「首个 applied」=端侧首次上报 applied==新 rev。`);
