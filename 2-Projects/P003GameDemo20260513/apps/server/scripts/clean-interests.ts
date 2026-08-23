/**
 * 兴趣污染存量清洗（2026-08-23 川哥拍板方案 B 配套·一次性脚本，可重复跑=幂等）。
 * 跑法（生产 /opt/p003/server 内）：
 *   set -a; . ./.env.local; set +a
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/clean-interests.ts --dry-run   # 先看 diff
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/clean-interests.ts             # 真跑（自动备份）
 *
 * 规则：
 *  1) 同义合并：一组归一互含的兴趣里保留 last_updated 最早那条（最初表达形态），其余删。
 *  2) dislike 对撞：active「不喜欢」条目归一后包含某兴趣 → 按「时间戳新者赢」——
 *     dislike.created_at >= 兴趣.last_updated 时删兴趣；兴趣更新（孩子后来又喜欢了）则保留。
 *
 * 🔙 回滚：真跑前把全部账号 interests 原值写入
 *     _backup/interests-backup-<ts>.json （{account_id: 原数组}）
 *   恢复 = NODE_OPTIONS=--experimental-sqlite npx tsx scripts/clean-interests.ts --restore <备份文件路径>
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { profileStore, isSameInterest, type InterestItem } from '../src/profile-store.js';
import { memoryItemStore } from '../src/memory-item-store.js';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const dbPath = resolve(process.cwd(), process.env.PROFILE_DB_PATH?.trim() || './data/profile.db');
const db = new DatabaseSync(dbPath);
const dryRun = process.argv.includes('--dry-run');
const restoreIdx = process.argv.indexOf('--restore');

if (restoreIdx > -1) {
  const file = process.argv[restoreIdx + 1];
  if (!file) throw new Error('用法: --restore <备份文件路径>');
  const backup = JSON.parse(readFileSync(file, 'utf8')) as Record<string, InterestItem[]>;
  for (const [acct, interests] of Object.entries(backup)) {
    db.prepare(`UPDATE family_member SET interests = ?, updated_at = ? WHERE account_id = ?`).run(
      JSON.stringify(interests), Date.now(), acct);
    console.log(`restored ${acct}: ${interests.length} 项`);
  }
  console.log('回滚完成');
  process.exit(0);
}

type Row = { account_id: string; interests: string };
const rows = db.prepare(`SELECT account_id, interests FROM family_member`).all() as Row[];
console.log(`账号总数: ${rows.length}${dryRun ? '（dry-run，不写库）' : ''}`);

const backup: Record<string, InterestItem[]> = {};
let changedAccounts = 0;

for (const row of rows) {
  let interests: InterestItem[];
  try { interests = JSON.parse(row.interests); } catch { continue; }
  if (!Array.isArray(interests) || interests.length === 0) continue;

  const before = interests.map((i) => i.value);
  // 规则 1：同义合并，保留 last_updated 最早
  const sorted = [...interests].sort((a, b) => (a.last_updated ?? 0) - (b.last_updated ?? 0));
  const merged: InterestItem[] = [];
  for (const it of sorted) {
    if (!merged.some((m) => isSameInterest(m.value, it.value))) merged.push(it);
  }
  // 规则 2：dislike 对撞（新者赢）
  const dislikes = memoryItemStore.listActiveDislikes(row.account_id);
  const kept = merged.filter((it) => {
    const hit = dislikes.find((d) => isSameInterest(d.content, it.value));
    if (!hit) return true;
    return (it.last_updated ?? 0) > hit.created_at; // 兴趣严格更新才保留
  });

  const after = kept.map((i) => i.value);
  if (JSON.stringify(before) === JSON.stringify(after)) continue;

  changedAccounts += 1;
  backup[row.account_id] = interests;
  console.log(`\n${row.account_id}`);
  console.log(`  前(${before.length}): ${before.join(' | ')}`);
  console.log(`  后(${after.length}): ${after.join(' | ') || '（空）'}`);
  if (!dryRun) {
    db.prepare(`UPDATE family_member SET interests = ?, updated_at = ? WHERE account_id = ?`).run(
      JSON.stringify(kept), Date.now(), row.account_id);
  }
}

if (!dryRun && changedAccounts) {
  mkdirSync('_backup', { recursive: true });
  const file = `_backup/interests-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`\n✅ 已清洗 ${changedAccounts} 个账号；回滚备份: ${file}`);
  console.log(`   回滚命令: NODE_OPTIONS=--experimental-sqlite npx tsx scripts/clean-interests.ts --restore ${file}`);
} else {
  console.log(`\n${dryRun ? 'dry-run 结束' : '无需清洗'}：受影响账号 ${changedAccounts} 个`);
}
