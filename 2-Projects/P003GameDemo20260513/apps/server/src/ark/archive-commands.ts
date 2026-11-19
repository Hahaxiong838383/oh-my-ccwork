import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {canonicalJson} from '../analytics/contracts.js';
const stamp=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),id=z.string().regex(/^[a-f0-9]{32}$/),sha=z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema=z.object({schema_version:z.literal(1),archive_id:id,kind:z.literal('ark_checkpoint'),created_at_ms:stamp,record_count:z.number().int().min(1).max(1000),bytes:z.number().int().min(1).max(1048576),sha256:sha,source_range:z.object({format:z.literal('ark_jsonl'),format_version:z.literal(1),lines:z.number().int().min(1).max(1000),first_id:stamp,last_id:stamp}).strict()}).strict();
const schema=z.discriminatedUnion('op',[
 z.object({op:z.literal('claim'),archive_id:id,now:stamp}).strict(),
 z.object({op:z.literal('prepare'),archive_id:id,manifest:manifestSchema}).strict(),
 z.object({op:z.literal('published'),archive_id:id}).strict(),
 z.object({op:z.literal('confirm'),archive_id:id,manifest:manifestSchema,rows_sha256:sha,verified_at_ms:stamp}).strict(),
 z.object({op:z.literal('prune_batch'),archive_id:id,manifest:manifestSchema,now:stamp}).strict(),
 z.object({op:z.literal('prune_baselines'),now:stamp}).strict(),
 z.object({op:z.literal('status'),state:z.enum(['attempt','success','failed']),now:stamp}).strict(),
]);
type Batch={archive_id:string;created_at_ms:number;state:string;manifest:string|null;record_count:number;bytes:number;first_id:number;last_id:number;verified_at_ms:number|null};
const DAY=86400000;
/** Fixed archive operations on the SAME connection as device writes. No filesystem,
 * network, await, arbitrary SQL, persistent queue, or transaction across requests. */
export function arkArchiveCommand(db:DatabaseSync,input:unknown):string|null{
 const q=schema.parse(input);
 const transaction=<T>(fn:()=>T):T=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}};
 const batch=(aid:string)=>{const b=db.prepare('SELECT * FROM ark_archive_batch WHERE archive_id=?').get(aid) as Batch|undefined;if(!b)throw Error('archive_batch_missing');return b;};
 const match=(b:Batch,m:z.infer<typeof manifestSchema>)=>{
  const r=m.source_range;
  if(m.archive_id!==b.archive_id||m.created_at_ms!==b.created_at_ms||m.record_count!==b.record_count||m.bytes!==b.bytes||r.lines!==b.record_count||r.first_id!==b.first_id||r.last_id!==b.last_id||r.first_id>r.last_id)throw Error('archive_manifest_mapping_mismatch');
  if(b.manifest&&canonicalJson(JSON.parse(b.manifest))!==canonicalJson(m))throw Error('archive_manifest_mapping_mismatch');
 };
 if(q.op==='claim'){
  const existing=db.prepare('SELECT archive_id FROM ark_archive_batch WHERE archive_id=?').get(q.archive_id);if(existing)return q.archive_id;
  const selected=db.prepare('SELECT id,bytes FROM ark_archive_outbox WHERE batch_id IS NULL ORDER BY id LIMIT 1000').all() as {id:number;bytes:number}[];
  const rows:typeof selected=[];let bytes=0;
  for(const r of selected){if(r.bytes>1048576)throw Error('archive_row_too_large');if(bytes+r.bytes>1048576)break;rows.push(r);bytes+=r.bytes;}
  if(!rows.length)return null;
  return transaction(()=>{
   db.prepare("INSERT INTO ark_archive_batch VALUES(?,?,'claimed',NULL,?,?,?,?,NULL)").run(q.archive_id,q.now,rows.length,bytes,rows[0].id,rows.at(-1)!.id);
   const changed=db.prepare('UPDATE ark_archive_outbox SET batch_id=? WHERE batch_id IS NULL AND id>=? AND id<=? RETURNING id,bytes').all(q.archive_id,rows[0].id,rows.at(-1)!.id) as typeof rows;
   changed.sort((a,b)=>a.id-b.id);
   if(JSON.stringify(changed)!==JSON.stringify(rows))throw Error('archive_claim_changed');return q.archive_id;
  });
 }
 if(q.op==='status'){
  if(q.state==='attempt')db.prepare('UPDATE ark_archive_stats SET last_attempt_ms=? WHERE id=1').run(q.now);
  else if(q.state==='success')db.prepare('UPDATE ark_archive_stats SET last_success_ms=?,last_error=NULL WHERE id=1').run(q.now);
  else db.exec("UPDATE ark_archive_stats SET last_error='export_failed' WHERE id=1");return null;
 }
 return transaction(()=>{
  if(q.op==='prune_baselines'){
   db.prepare('DELETE FROM ark_archive_baseline WHERE grant_id IN (SELECT b.grant_id FROM ark_archive_baseline b WHERE received_at_ms<? AND NOT EXISTS(SELECT 1 FROM ark_grant g WHERE g.grant_id=b.grant_id) AND NOT EXISTS(SELECT 1 FROM ark_archive_outbox o WHERE o.grant_id=b.grant_id) LIMIT 100)').run(q.now-90*DAY);return null;
  }
  const b=batch(q.archive_id);
  if(q.op==='published'){
   if(!b.manifest)throw Error('archive_not_prepared');if(b.state!=='complete')db.prepare("UPDATE ark_archive_batch SET state='published' WHERE archive_id=?").run(q.archive_id);return null;
  }
  match(b,q.manifest);
  if(q.op==='prepare'){
   if(!b.manifest)db.prepare("UPDATE ark_archive_batch SET manifest=?,state='prepared' WHERE archive_id=?").run(canonicalJson(q.manifest),q.archive_id);return null;
  }
  if(q.op==='prune_batch'){
   if(b.state!=='complete'||b.verified_at_ms===null||b.verified_at_ms>=q.now-90*DAY)throw Error('archive_gc_not_eligible');
   db.prepare("DELETE FROM ark_archive_batch WHERE archive_id=? AND state='complete'").run(q.archive_id);return null;
  }
  if(!b.manifest)throw Error('archive_not_prepared');if(b.state==='complete')return null;
  const rows=db.prepare('SELECT id,grant_id,received_at_ms,envelope,bytes,reserved_bytes,batch_id FROM ark_archive_outbox WHERE batch_id=? ORDER BY id LIMIT 1001').all(q.archive_id);
  if(rows.length!==b.record_count)throw Error('archive_mapping_changed');
  const fingerprint=createHash('sha256').update(JSON.stringify(rows.map(r=>[r.id,r.grant_id,r.received_at_ms,r.envelope,r.bytes,r.reserved_bytes,r.batch_id]))).digest('hex');
  if(fingerprint!==q.rows_sha256)throw Error('archive_mapping_changed');
  db.prepare('DELETE FROM ark_archive_outbox WHERE batch_id=?').run(q.archive_id);
  db.prepare("UPDATE ark_archive_batch SET state='complete',verified_at_ms=? WHERE archive_id=?").run(q.verified_at_ms,q.archive_id);
  db.prepare('UPDATE ark_archive_stats SET last_ack_ms=MAX(COALESCE(last_ack_ms,0),?) WHERE id=1').run(q.verified_at_ms);return null;
 });
}
