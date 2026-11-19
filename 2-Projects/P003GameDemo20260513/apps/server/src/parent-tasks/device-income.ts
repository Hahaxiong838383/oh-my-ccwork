import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LegacyRecord } from '../ark/records-legacy.js';

export type IncomeProof = {
  settlement_id: string; occurrence_id: string; save_id: string;
  record_id: string; amount: number; post_snapshot_id: string;
};
export type IncomeIdentity = {
  sn: string; public_id: string; account_id: string; parent_account_id: string;
  binding_version: number; epoch: number;
};

/** Receipts are committed atomically with paid. History reads never initialize the task store. */
export function paidTaskRecords(identity: IncomeIdentity): IncomeProof[] {
  const path = resolve(process.env.PARENT_TASKS_DB_PATH ?? './data/parent-tasks.db');
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pt_wallet_proof'").get()) return [];
    return db.prepare(`SELECT settlement_id,occurrence_id,save_id,record_id,amount,post_snapshot_id
      FROM pt_wallet_proof WHERE sn=? AND public_id=? AND device_account=? AND owner=?
      AND binding_version=? AND epoch=?`).all(identity.sn, identity.public_id, identity.account_id,
      identity.parent_account_id, identity.binding_version, identity.epoch) as IncomeProof[];
  } finally { db.close(); }
}

/** Accept the R1 facts only when the grant, durable receipt and actual wallet movement agree. */
export function matchesTaskIncome(record: LegacyRecord, proof: IncomeProof): boolean {
  if (record.record_kind !== 'business_commit' || record.source_mode !== 'normal'
    || record.data.previous_source_mode !== 'normal' || record.save_id !== proof.save_id
    || record.record_id !== proof.record_id) return false;
  const family = 'C-FAMILY-001';
  const grant = record.data.grants.find(g => g.reward_instance_id === proof.settlement_id);
  if (!grant || grant.source_kind !== 'parent_task' || grant.source_id !== proof.occurrence_id
    || grant.resolved_rewards.length !== 1) return false;
  const [reward] = grant.resolved_rewards;
  if (reward.kind !== 'currency' || reward.item_id !== family || reward.quantity !== proof.amount) return false;
  const change = record.data.wallet_changes.find(c => c.resource_id === family);
  const deposited = record.data.grants.flatMap(g => g.resolved_rewards)
    .filter(r => r.kind === 'currency' && (r.item_id === family || r.item_id === 'C-COIN-001'))
    .reduce((sum, r) => sum + r.quantity, 0);
  return !!change && change.delta > 0 && change.delta === deposited;
}
