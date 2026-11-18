import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonical } from '../ark/records-contract.js';
import type { IncomeProof } from './device-income.js';
import type { TaskScope } from './scope.js';
import { taskStore } from './store.js';

type Store = ReturnType<typeof taskStore>;
type Item = ReturnType<Store['allItems']>[number];
const key = z.string().min(1).max(96).regex(/^[A-Za-z0-9_.:-]+$/);
const natural = z.number().int().nonnegative().safe();
const common = { receipt_id:key, task_id:key, occurrence_id:key, binding_version:natural, save_id:key };
const receiptSchema = z.discriminatedUnion('kind',[
  z.object({...common,kind:z.literal('task_received'),definition_version:natural.min(1)}).strict(),
  z.object({...common,kind:z.literal('wallet_applied'),settlement_id:key,amount:natural.min(1).max(500),
    currency:z.literal('C-FAMILY-001'),record_id:key,applied_at_ms:natural.min(1),post_snapshot_id:key}).strict()
]);
export const syncSchema=z.object({contract_version:z.literal('1.0'),binding_version:natural,save_id:key,
  source_mode:z.enum(['normal','gm','unknown']),client_version:z.string().min(1).max(128),
  cursor:z.string().min(1).max(300).optional(),since_cursor:z.string().min(1).max(96).optional()}).strict();
export const batchSchema=z.object({contract_version:z.literal('1.0'),receipts:z.array(z.unknown()).min(1).max(100)}).strict();
export class DeviceTaskError extends Error {
  constructor(readonly status:400|401|403|404|409|413|426|429|503, readonly code:string, readonly reason:string){super(reason);}
}
type Authorization = {settlement_id:string;occurrence_id:string;task_id:string;currency:'C-FAMILY-001';
  amount:number;binding_version:number;save_id:string;expires_at_ms:number};
type Image={items:Item[];deleted_task_ids:string[];authorizations:Authorization[]};
type Snapshot={id:number;token:string;body:string;digest:string;created_ms:number};
type Receipt=z.infer<typeof receiptSchema>;
const snapshotTtl=30*60_000;
const authorizationTtl=10*60_000;
const initialized=new WeakSet<DatabaseSync>();

export function installDeviceTaskSchema(db:DatabaseSync){
  if(initialized.has(db))return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS pt_device_image(id INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL,
      save_id TEXT NOT NULL, mode TEXT NOT NULL, token TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS pt_device_image_current ON pt_device_image(scope_key,save_id,mode,id DESC);
    CREATE INDEX IF NOT EXISTS pt_device_image_expiry ON pt_device_image(created_ms);
    CREATE TABLE IF NOT EXISTS pt_device_target(settlement_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,save_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pt_device_window(settlement_id TEXT NOT NULL,expires_ms INTEGER NOT NULL,issued_ms INTEGER NOT NULL,PRIMARY KEY(settlement_id,expires_ms));
    CREATE TABLE IF NOT EXISTS pt_device_offer(scope_key TEXT NOT NULL,save_id TEXT NOT NULL,task_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(scope_key,save_id,task_id,occurrence_id,version));
    CREATE TABLE IF NOT EXISTS pt_device_receipt(scope_key TEXT NOT NULL,receipt_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope_key,receipt_id));
    CREATE TABLE IF NOT EXISTS pt_wallet_proof(settlement_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,sn TEXT NOT NULL,public_id TEXT NOT NULL,
      device_account TEXT NOT NULL,owner TEXT NOT NULL,binding_version INTEGER NOT NULL,epoch INTEGER NOT NULL,occurrence_id TEXT NOT NULL,
      save_id TEXT NOT NULL,record_id TEXT NOT NULL,amount INTEGER NOT NULL,post_snapshot_id TEXT NOT NULL,receipt_body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS pt_wallet_proof_scope ON pt_wallet_proof(sn,public_id,owner,binding_version,epoch);
  `);
  initialized.add(db);
}
function invalidCursor():never {throw new DeviceTaskError(409,'cursor_invalid','full_sync_required');}

function snapshot(db:DatabaseSync,scope:TaskScope,save:string,mode:string,token:string,now:number):Snapshot {
  const result=db.prepare('SELECT * FROM pt_device_image WHERE token=? AND scope_key=? AND save_id=? AND mode=? AND created_ms>?')
    .get(token,scope.key,save,mode,now-snapshotTtl) as Snapshot|undefined;
  return result??invalidCursor();
}
function buildImage(store:Store,scope:TaskScope,save:string,normalSave:boolean,now:number):Image {
  const db=store.db, deleted_task_ids=store.deletedTaskIds(scope);
  const items=store.allItems(scope).filter(i=>!(deleted_task_ids.includes(i.task_id)&&i.state==='ended_below_target'))
    .map(i=>({...i,description:null}));
  const authorizations:Authorization[]=[];
  for(const i of items){
    if(!normalSave||i.state!=='pending_payment'||!i.settlement_id)continue;
    db.prepare('INSERT OR IGNORE INTO pt_device_target VALUES(?,?,?)').run(i.settlement_id,scope.key,save);
    const target=db.prepare('SELECT save_id FROM pt_device_target WHERE settlement_id=? AND scope_key=?').get(i.settlement_id,scope.key);
    if(target?.save_id!==save)continue;
    const win=db.prepare('SELECT MAX(expires_ms) expiry FROM pt_device_window WHERE settlement_id=?').get(i.settlement_id);
    const expiry=Number(win?.expiry??0);
    authorizations.push({settlement_id:i.settlement_id,occurrence_id:i.occurrence_id,task_id:i.task_id,currency:'C-FAMILY-001',
      amount:i.reward_coins,binding_version:scope.bindingVersion,save_id:save,expires_at_ms:expiry>now+60_000?expiry:now+authorizationTtl});
  }
  return {items,deleted_task_ids,authorizations};
}

export function deviceTaskSync(store:Store,scope:TaskScope,body:z.infer<typeof syncSchema>,trustedSave:boolean,now:number,pageSize=50){
  if(body.binding_version!==scope.bindingVersion)throw new DeviceTaskError(409,'identity_conflict','binding_version_mismatch');
  const db=store.db;
  const save=body.save_id,mode=body.source_mode;
  let token=body.since_cursor,offset=0,current:Snapshot;
  if(body.cursor){
    const parts=/^page\/([a-z0-9-]{36})\/([a-z0-9-]{36}|full)\/(\d{1,9})$/.exec(body.cursor);
    if(!parts)invalidCursor();
    const base=parts[2]==='full'?undefined:parts[2];
    if(token&&token!==base)invalidCursor();
    token=base;offset=Number(parts[3]);current=snapshot(db,scope,save,mode,parts[1],now);
  } else {
    store.refresh(scope,now);
    const image=buildImage(store,scope,save,mode==='normal'&&trustedSave,now);
    const serialized=JSON.stringify(image), digest=createHash('sha256').update(serialized).digest('hex');
    db.prepare('DELETE FROM pt_device_image WHERE created_ms<=?').run(now-snapshotTtl);
    const last=db.prepare('SELECT * FROM pt_device_image WHERE scope_key=? AND save_id=? AND mode=? ORDER BY id DESC LIMIT 1')
      .get(scope.key,save,mode) as Snapshot|undefined;
    if(last?.digest===digest)current=last;
    else{
      const cursor=randomUUID();
      db.prepare('INSERT INTO pt_device_image(scope_key,save_id,mode,token,digest,body,created_ms) VALUES(?,?,?,?,?,?,?)')
        .run(scope.key,save,mode,cursor,digest,serialized,now);
      current=snapshot(db,scope,save,mode,cursor,now);
    }
  }
  const full=JSON.parse(current.body) as Image;
  const prior:Image|undefined=token?JSON.parse(snapshot(db,scope,save,mode,token,now).body):undefined;
  const oldItems=new Map(prior?.items.map(i=>[i.occurrence_id,canonical(i)]));
  const oldGrants=new Map(prior?.authorizations.map(g=>[g.settlement_id,canonical(g)]));
  const grants=full.authorizations.filter(g=>canonical(g)!==oldGrants.get(g.settlement_id));
  const grantIds=new Set(grants.map(g=>g.occurrence_id));
  const changed=full.items.filter(i=>grantIds.has(i.occurrence_id)||oldItems.get(i.occurrence_id)!==canonical(i));
  if(offset>changed.length)invalidCursor();
  const items=changed.slice(offset,offset+pageSize),delivered=new Set(items.map(i=>i.occurrence_id));
  const hasMore=offset+items.length<changed.length;
  const authorizations=grants.filter(g=>delivered.has(g.occurrence_id));
  for(const item of items)db.prepare('INSERT OR IGNORE INTO pt_device_offer VALUES(?,?,?,?,?)')
    .run(scope.key,save,item.task_id,item.occurrence_id,item.definition_version);
  for(const grant of authorizations){
    const currentItem=store.item(scope,grant.task_id,grant.occurrence_id);
    if(!trustedSave||grant.expires_at_ms<=now||currentItem.state!=='pending_payment'
      ||currentItem.settlement_id!==grant.settlement_id||currentItem.reward_coins!==grant.amount)invalidCursor();
    db.prepare('INSERT OR IGNORE INTO pt_device_window VALUES(?,?,?)').run(grant.settlement_id,grant.expires_at_ms,now);
  }
  return {mode:prior?'delta':'snapshot',snapshot_version:current.id,server_now_ms:now,
    has_more:hasMore,next_cursor:hasMore?`page/${current.token}/${token??'full'}/${offset+items.length}`:null,
    sync_cursor:hasMore?null:current.token,items,deleted_task_ids:offset===0?full.deleted_task_ids.filter(id=>!prior?.deleted_task_ids.includes(id)):[],authorizations};
}

function performReceipt(store:Store,scope:TaskScope,r:Receipt,now:number){
  const db=store.db;
  if(r.binding_version!==scope.bindingVersion)return 'binding_version_mismatch';
  const stored=db.prepare('SELECT body FROM pt_device_receipt WHERE scope_key=? AND receipt_id=?').get(scope.key,r.receipt_id);
  if(stored)return stored.body===canonical(r)?'duplicate':'receipt_id_conflict';
  if(r.kind==='task_received'){
    const offered=db.prepare('SELECT 1 FROM pt_device_offer WHERE scope_key=? AND save_id=? AND task_id=? AND occurrence_id=? AND version=?')
      .get(scope.key,r.save_id,r.task_id,r.occurrence_id,r.definition_version);
    if(!offered)return 'task_version_not_offered';
    if(!store.recordReceived(scope,r.task_id,r.definition_version))return 'task_version_mismatch';
  }else{
    const target=db.prepare('SELECT save_id FROM pt_device_target WHERE settlement_id=? AND scope_key=?').get(r.settlement_id,scope.key);
    if(!target)return 'authorization_not_found';
    if(target.save_id!==r.save_id)return 'save_id_mismatch';
    const {receipt_id,...facts}=r;
    const prior=db.prepare('SELECT receipt_body FROM pt_wallet_proof WHERE settlement_id=? AND scope_key=?').get(r.settlement_id,scope.key);
    if(prior){
      if(prior.receipt_body!==canonical(facts))return 'settlement_result_conflict';
      db.prepare('INSERT INTO pt_device_receipt VALUES(?,?,?)').run(scope.key,receipt_id,canonical(r));return 'duplicate';
    }
    const item=store.allItems(scope).find(i=>i.occurrence_id===r.occurrence_id&&i.task_id===r.task_id&&i.settlement_id===r.settlement_id);
    if(!item||item.state!=='pending_payment'||item.reward_coins!==r.amount)return 'settlement_mismatch';
    if(!r.record_id.startsWith(r.save_id+':')||!/^\d+$/.test(r.record_id.slice(r.save_id.length+1)))return 'record_id_mismatch';
    const window=db.prepare('SELECT 1 FROM pt_device_window WHERE settlement_id=? AND issued_ms<=? AND expires_ms>?')
      .get(r.settlement_id,r.applied_at_ms,r.applied_at_ms);
    if(!window||r.applied_at_ms>now)return 'applied_outside_authorization';
    if(!store.recordPaid(scope,r.task_id,r.occurrence_id,r.settlement_id,r.post_snapshot_id,r.applied_at_ms))return 'settlement_mismatch';
    db.prepare('INSERT INTO pt_wallet_proof VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.settlement_id,scope.key,scope.sn,scope.publicId,
      scope.accountId,scope.owner,scope.bindingVersion,scope.epoch,r.occurrence_id,r.save_id,r.record_id,r.amount,r.post_snapshot_id,canonical(facts));
  }
  db.prepare('INSERT INTO pt_device_receipt VALUES(?,?,?)').run(scope.key,r.receipt_id,canonical(r));return 'accepted';
}

export function deviceTaskReceipts(store:Store,scope:TaskScope,values:unknown[],now:number){
  const accepted_receipt_ids:string[]=[],duplicated_receipt_ids:string[]=[],rejected:{receipt_id:string|null;reason:string;retryable:boolean}[]=[];
  for(const raw of values){
    const parsed=receiptSchema.safeParse(raw);
    if(!parsed.success){
      const id=z.object({receipt_id:key}).safeParse(raw);
      rejected.push({receipt_id:id.success?id.data.receipt_id:null,reason:'invalid_receipt',retryable:false});continue;
    }
    const r=parsed.data,result=performReceipt(store,scope,r,now);
    if(result==='accepted')accepted_receipt_ids.push(r.receipt_id);
    else if(result==='duplicate')duplicated_receipt_ids.push(r.receipt_id);
    else rejected.push({receipt_id:r.receipt_id,reason:result,retryable:false});
  }
  return {accepted_receipt_ids,duplicated_receipt_ids,rejected};
}

export function taskProof(db:DatabaseSync,scope:TaskScope,id:string){
  return db.prepare('SELECT settlement_id,occurrence_id,save_id,record_id,amount,post_snapshot_id FROM pt_wallet_proof WHERE scope_key=? AND settlement_id=?')
    .get(scope.key,id) as IncomeProof|undefined;
}
