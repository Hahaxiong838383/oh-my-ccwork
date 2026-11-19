import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../analytics/contracts.js';
import type {ArkSnapshot} from './contracts.js';
import type {ArkGrant} from './store.js';

export type ArkArchivePolicy={enabled:boolean;limitBytes:number;reserveBytes:number;freeBytes:number};
export const archiveHash=(s:string)=>createHash('sha256').update(s).digest('hex');
// Includes outbox body, encoded work/published file, SQLite/WAL/index overhead.
// Whole Analytics backups retain their separate capacity model and disk reserve.
export const archiveReservation=(bytes:number)=>3*(bytes+1024);
export function installArkArchive(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS ark_archive_baseline(grant_id TEXT PRIMARY KEY,signature TEXT NOT NULL,received_at_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ark_archive_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,grant_id TEXT NOT NULL,received_at_ms INTEGER NOT NULL,envelope TEXT NOT NULL,bytes INTEGER NOT NULL,reserved_bytes INTEGER NOT NULL,batch_id TEXT);
 CREATE INDEX IF NOT EXISTS ark_archive_pending ON ark_archive_outbox(batch_id,id);
 CREATE INDEX IF NOT EXISTS ark_archive_grant ON ark_archive_outbox(grant_id);
 CREATE TABLE IF NOT EXISTS ark_archive_batch(archive_id TEXT PRIMARY KEY,created_at_ms INTEGER NOT NULL,state TEXT NOT NULL,manifest TEXT,record_count INTEGER NOT NULL,bytes INTEGER NOT NULL,first_id INTEGER NOT NULL,last_id INTEGER NOT NULL,verified_at_ms INTEGER);
 CREATE INDEX IF NOT EXISTS ark_archive_batch_state ON ark_archive_batch(state,created_at_ms);
 CREATE TABLE IF NOT EXISTS ark_archive_stats(id INTEGER PRIMARY KEY CHECK(id=1),pending_records INTEGER NOT NULL DEFAULT 0,pending_bytes INTEGER NOT NULL DEFAULT 0,reserved_bytes INTEGER NOT NULL DEFAULT 0,last_ack_ms INTEGER,last_attempt_ms INTEGER,last_success_ms INTEGER,last_error TEXT);
 INSERT OR IGNORE INTO ark_archive_stats(id) VALUES(1);
 CREATE TRIGGER IF NOT EXISTS ark_archive_added AFTER INSERT ON ark_archive_outbox BEGIN UPDATE ark_archive_stats SET pending_records=pending_records+1,pending_bytes=pending_bytes+NEW.bytes,reserved_bytes=reserved_bytes+NEW.reserved_bytes WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS ark_archive_removed AFTER DELETE ON ark_archive_outbox BEGIN UPDATE ark_archive_stats SET pending_records=pending_records-1,pending_bytes=pending_bytes-OLD.bytes,reserved_bytes=reserved_bytes-OLD.reserved_bytes WHERE id=1; END;`);
}
function signature(s:ArkSnapshot){
 const r=s.progress.next_reward;
 return archiveHash(canonicalJson({wallets:s.wallets,card:s.inventory['M-CARD-001'],reward:{status:r.status,kind:r.kind,item_id:r.item_id,stage_id:r.stage_id},claimable_count:s.progress.claimable_count,source_mode:s.source_mode,content_version:s.content_version,config_revision:s.config_revision,logical_day:s.logical_day}));
}
/** Caller owns Ark transaction. No network, export, config lock, or growing-table scan. */
export function appendArkCheckpoint(db:DatabaseSync,g:ArkGrant,s:ArkSnapshot,now:number,p:ArkArchivePolicy){
 if(!p.enabled)return;
 const sig=signature(s),old=db.prepare('SELECT signature,received_at_ms FROM ark_archive_baseline WHERE grant_id=?').get(g.grant_id) as {signature:string;received_at_ms:number}|undefined;
 if(old&&old.signature===sig&&now-old.received_at_ms<300000)return;
 const seq=Number((db.prepare("SELECT seq FROM sqlite_sequence WHERE name='ark_archive_outbox'").get() as {seq:number}|undefined)?.seq??0)+1;
 if(!Number.isSafeInteger(seq))throw new Error('archive_sequence_exhausted');
 const envelope=canonicalJson({format_version:1,record_id:seq,sn:g.sn,account_id:g.account_id,epoch:g.epoch,grant_id:g.grant_id,source_mode:s.source_mode,received_at_ms:now,body_hash:archiveHash(canonicalJson(s)),snapshot:s});
 const bytes=Buffer.byteLength(envelope+'\n'),reserved=archiveReservation(bytes);
 const stats=db.prepare('SELECT reserved_bytes FROM ark_archive_stats WHERE id=1').get() as {reserved_bytes:number};
 // Conservatively reserve all outstanding bodies even if part is already on disk.
 // Checking only this row would let queued future exports consume the safety reserve.
 if(![p.limitBytes,p.reserveBytes,p.freeBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||stats.reserved_bytes+reserved>p.limitBytes||p.freeBytes<p.reserveBytes+stats.reserved_bytes+reserved)throw new Error('archive_buffer_full');
 db.prepare('INSERT INTO ark_archive_outbox(id,grant_id,received_at_ms,envelope,bytes,reserved_bytes) VALUES(?,?,?,?,?,?)').run(seq,g.grant_id,now,envelope,bytes,reserved);
 db.prepare('INSERT INTO ark_archive_baseline VALUES(?,?,?) ON CONFLICT(grant_id) DO UPDATE SET signature=excluded.signature,received_at_ms=excluded.received_at_ms').run(g.grant_id,sig,now);
}
export function arkArchiveStatus(db:DatabaseSync,enabled:boolean){
 const r=db.prepare('SELECT * FROM ark_archive_stats WHERE id=1').get() as Record<string,number|string|null>;
 const first=db.prepare('SELECT received_at_ms FROM ark_archive_outbox ORDER BY id LIMIT 1').get() as {received_at_ms:number}|undefined;
 const state=!enabled?(Number(r.pending_records)?'disabled_draining':'disabled'):r.last_error?'error':Number(r.pending_records)?'pending':'idle';
 return {state,enabled,pending_records:r.pending_records,pending_bytes:r.pending_bytes,reserved_bytes:r.reserved_bytes,oldest_pending_ms:first?.received_at_ms??null,last_attempt_ms:r.last_attempt_ms,last_success_ms:r.last_success_ms,last_ack_ms:r.last_ack_ms,last_error:r.last_error,retention_days:90};
}
