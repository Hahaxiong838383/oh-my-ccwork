/**
 * 数据修复（2026-09-03 L1）：逐轮「短句 −0.01」镜像把设备的话语量压到地板（生产 194 次净 −1.94）。
 * 规则已改会话级；本脚本把每台设备的话语量抬回其有效基线（模板五维或出厂），只改低于基线的，幂等，记账 rule=cc_data_fix。
 * 跑法(aliyun-hk)：cd /opt/p003/server && cp data/profile.db data/profile.db.bak-$(date +%Y%m%d-%H%M%S)-talk && \
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/fix-talkativeness-20260903.ts [--dry-run]
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { traitStore, TRAIT_LABELS } from '../src/trait-store.js';
import { growthLedgerStore } from '../src/growth-ledger-store.js';

const dry = process.argv.includes('--dry-run');
const db = new DatabaseSync(resolve(process.cwd(), process.env.PROFILE_DB_PATH?.trim() || './data/profile.db'));
const rows = db.prepare(`SELECT account_id, talkativeness FROM trait_state WHERE account_id LIKE 'device-%'`).all() as { account_id: string; talkativeness: number }[];
let fixed = 0;
for (const r of rows) {
  const base = traitStore.baselineFor(r.account_id).talkativeness;
  const tag = '…' + r.account_id.slice(-4);
  if (r.talkativeness >= base - 1e-9) { console.log(`${tag} talkativeness=${r.talkativeness.toFixed(3)} ≥ 基线 ${base} 不动`); continue; }
  console.log(`${tag} talkativeness ${r.talkativeness.toFixed(3)} → ${base}${dry ? ' (dry-run)' : ''}`);
  if (dry) continue;
  db.prepare(`UPDATE trait_state SET talkativeness = ?, updated_at = ? WHERE account_id = ?`).run(base, Date.now(), r.account_id);
  growthLedgerStore.record(r.account_id, {
    module: 'trait', dimension: TRAIT_LABELS.talkativeness, from: r.talkativeness, to: base,
    triggerQuote: '', rule: 'cc_data_fix', theory: 'setpoint',
    note: '修复：逐轮短句镜像（ASR 切句假象）把话语量压到地板，抬回有效基线；规则已改会话级（L1）',
  });
  fixed += 1;
}
console.log(`done fixed=${fixed} of ${rows.length}`);
