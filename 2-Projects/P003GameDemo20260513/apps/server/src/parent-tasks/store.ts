import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dashboardArk } from '../ark/dashboard.js';
import { arkStore } from '../ark/service.js';
import { telemetryStore } from '../telemetry-store.js';
import { TaskError, invalid, missing, type TaskScope } from './scope.js';
import { calculation, periodLength, periodStart, ruleFrom, type Rule, type State, type TaskItem } from './rules.js';

type Definition = { task_id:string; version:number; config:string; received_version:number|null;
  created_ms:number;updated_ms:number;deleted_ms:number|null };
type Occurrence = { scope_key:string; task_id:string; occurrence_id:string; rule_version:number; config:string; start_ms:number;
  end_ms:number; state:State; progress:string; settlement_id:string|null; post_snapshot_id:string|null; applied_ms:number|null };
type Joined = Occurrence & {version:number; received_version:number|null};
const id = (prefix:string) => prefix+'_'+randomUUID().replaceAll('-','');
const activeView = (state:State) => state!=='ended_below_target' && state!=='paid';
const lockError = () => new TaskError(409,'state_conflict','occurrence_locked');
function canonical(value:unknown):string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}

function present(row:Joined):TaskItem {
  return {...JSON.parse(row.config),task_id:row.task_id,occurrence_id:row.occurrence_id,
    definition_version:row.version,rule_version:row.rule_version,state:row.state,
    period_start_ms:row.start_ms,period_end_ms:row.end_ms,progress:JSON.parse(row.progress),
    device_received_version:row.received_version,settlement_id:row.settlement_id,
    actions:row.state==='active'?['edit','delete']:row.state==='awaiting_confirmation'?['confirm']:[]};
}
export class TaskStore {
  readonly db:DatabaseSync;
  constructor(path:string) {
    mkdirSync(dirname(path),{recursive:true});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2500;
      CREATE TABLE IF NOT EXISTS pt_scope(scope_key TEXT PRIMARY KEY,since_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pt_definition(
        scope_key TEXT NOT NULL,task_id TEXT PRIMARY KEY,version INTEGER NOT NULL,config TEXT NOT NULL,
        received_version INTEGER,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,deleted_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS pt_def_scope ON pt_definition(scope_key,task_id);
      CREATE TABLE IF NOT EXISTS pt_occurrence(
        scope_key TEXT NOT NULL,task_id TEXT NOT NULL,occurrence_id TEXT PRIMARY KEY,
        rule_version INTEGER NOT NULL,config TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,
        progress TEXT NOT NULL,state TEXT NOT NULL,settlement_id TEXT UNIQUE,post_snapshot_id TEXT,applied_ms INTEGER,
        snapshot_seen INTEGER NOT NULL DEFAULT 0,UNIQUE(scope_key,task_id,start_ms)
      );
      CREATE INDEX IF NOT EXISTS pt_occurrence_scope ON pt_occurrence(scope_key,state);
      CREATE TABLE IF NOT EXISTS pt_request(scope_key TEXT,operation TEXT,key TEXT,digest TEXT NOT NULL,
        result TEXT NOT NULL,PRIMARY KEY(scope_key,operation,key));`);
  }
  transaction<T>(fn:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch(err) { this.db.exec('ROLLBACK'); throw err; }
  }
  private addPeriod(scope:TaskScope,taskId:string,version:number,rule:Rule,start:number) {
    const {progress}=calculation(rule,new Map());
    this.db.prepare(`INSERT INTO pt_occurrence(scope_key,task_id,occurrence_id,rule_version,config,start_ms,end_ms,progress,state)
      VALUES(?,?,?,?,?,?,?,?,'active')`).run(scope.key,taskId,id('occ'),version,JSON.stringify(rule),start,start+periodLength(rule.template),JSON.stringify(progress));
  }
  /** Call within the same transaction as the read/write, including device sync. */
  refresh(scope:TaskScope,now=Date.now()) {
    // Historical approval is checked on every request. Only a conservative, positive
    // start for ordinary ownership is retained across later unrelated registry edits.
    let since=scope.historySinceMs;
    if (since>0) {
      this.db.prepare('INSERT INTO pt_scope VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET since_ms=MIN(since_ms,excluded.since_ms)').run(scope.key,since);
      since=Number(this.db.prepare('SELECT since_ms FROM pt_scope WHERE scope_key=?').get(scope.key)!.since_ms);
    }
    const definitions = this.db.prepare('SELECT * FROM pt_definition WHERE scope_key=?').all(scope.key) as Definition[];
    for (const def of definitions) {
      const rule:Rule=JSON.parse(def.config);
      if (def.deleted_ms===null && rule.repeat==='repeat') {
        const last=this.db.prepare('SELECT MAX(end_ms) AS end_ms FROM pt_occurrence WHERE scope_key=? AND task_id=?').get(scope.key,def.task_id)!;
        for (let start=Number(last.end_ms); start>0 && start<=now; start+=periodLength(rule.template)) this.addPeriod(scope,def.task_id,def.version,rule,start);
      }
      const periods=this.db.prepare(`SELECT * FROM pt_occurrence WHERE scope_key=? AND task_id=? AND state IN ('active','ended_below_target')`).all(scope.key,def.task_id) as Occurrence[];
      for (const period of periods) {
        const end=Math.min(period.end_ms,def.deleted_ms??now,now);
        const totals=end>period.start_ms ? telemetryStore.focusUsageMillis(scope.sn,period.start_ms,end,since) : new Map();
        const {progress,eligible}=calculation(JSON.parse(period.config),totals);
        const state:State=eligible?'awaiting_confirmation':def.deleted_ms!==null||period.end_ms<=now?'ended_below_target':'active';
        const value=JSON.stringify(progress);
        if (value!==period.progress || state!==period.state)
          this.db.prepare('UPDATE pt_occurrence SET progress=?,state=? WHERE occurrence_id=? AND scope_key=?').run(value,state,period.occurrence_id,scope.key);
      }
    }
  }
  private rows(scope:TaskScope, where='', args:string[]=[]) {
    return this.db.prepare(`SELECT o.*,d.version,d.received_version FROM pt_occurrence o JOIN pt_definition d USING(scope_key,task_id)
      WHERE o.scope_key=? ${where} ORDER BY CASE o.state WHEN 'awaiting_confirmation' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
      CASE WHEN o.state='active' THEN d.updated_ms ELSE -o.start_ms END,o.occurrence_id`).all(scope.key,...args) as Joined[];
  }
  allItems(scope:TaskScope):TaskItem[] { return this.rows(scope).map(present); }
  deletedTaskIds(scope:TaskScope):string[] {
    return this.db.prepare('SELECT task_id FROM pt_definition WHERE scope_key=? AND deleted_ms IS NOT NULL ORDER BY task_id').all(scope.key).map(r=>String(r.task_id));
  }
  item(scope:TaskScope,task:string,occurrence:string) {
    const row=this.rows(scope,'AND o.task_id=? AND o.occurrence_id=?',[task,occurrence])[0];
    if (!row) throw missing();
    return present(row);
  }
  wallet(scope:TaskScope) {
    const snap=dashboardArk(scope.sn);
    const family_coin=snap.available?snap.wallets.family_coin:null;
    const snapshot_id=snap.available?snap.snapshot_id:null;
    if (family_coin===null || !snapshot_id) return {family_coin:null,snapshot_id:null,sync_state:'unknown'};
    const waiting=this.db.prepare(`SELECT occurrence_id,post_snapshot_id FROM pt_occurrence
      WHERE scope_key=? AND state='paid' AND snapshot_seen=0`).all(scope.key);
    const identity={sn:scope.sn,account_id:scope.accountId,epoch:scope.epoch};
    let syncing=false;
    for (const row of waiting) {
      if (row.post_snapshot_id===snapshot_id || arkStore().hasWalletSnapshot(identity,String(row.post_snapshot_id))) {
        this.db.prepare('UPDATE pt_occurrence SET snapshot_seen=1 WHERE scope_key=? AND occurrence_id=?').run(scope.key,String(row.occurrence_id));
      } else syncing=true;
    }
    return {family_coin,snapshot_id,sync_state:syncing?'syncing':'synced'};
  }
  list(scope:TaskScope,view:string,limit:number,cursor?:string) {
    if (!['active','history','all'].includes(view) || !Number.isInteger(limit) || limit<1 || limit>100) throw invalid('invalid_pagination');
    const items=this.allItems(scope).filter(i=>view==='all'||activeView(i.state)===(view==='active'));
    let start=0;
    if (cursor!==undefined) {
      let raw:unknown;
      try {raw=JSON.parse(Buffer.from(cursor,'base64url').toString());} catch {throw invalid('invalid_cursor');}
      if (!Array.isArray(raw)||raw.length!==3||raw[0]!==scope.key||raw[1]!==view) throw invalid('invalid_cursor');
      const index=items.findIndex(i=>i.occurrence_id===raw[2]);
      if (index<0) throw invalid('invalid_cursor');
      start=index+1;
    }
    const page=items.slice(start,start+limit);
    const next_cursor=start+limit<items.length?Buffer.from(JSON.stringify([scope.key,view,page.at(-1)!.occurrence_id])).toString('base64url'):null;
    return {items:page,wallet:this.wallet(scope),next_cursor};
  }
  write(scope:TaskScope,operation:string,key:string|undefined,body:unknown,fn:()=>object) {
    if (!key?.trim() || key.length>256) throw invalid('invalid_idempotency_key');
    const digest=createHash('sha256').update(canonical(body)).digest('hex');
    const prior=this.db.prepare('SELECT digest,result FROM pt_request WHERE scope_key=? AND operation=? AND key=?').get(scope.key,operation,key);
    if (prior) {
      if (digest!==prior.digest) throw new TaskError(409,'idempotency_conflict','key_reused_with_different_body');
      return JSON.parse(String(prior.result));
    }
    const result=fn();
    this.db.prepare('INSERT INTO pt_request VALUES(?,?,?,?,?)').run(scope.key,operation,key,digest,JSON.stringify(result));
    return result;
  }
  create(scope:TaskScope,body:unknown,now:number) {
    const rule=ruleFrom(body);
    const duplicate=this.db.prepare(`SELECT 1 FROM pt_definition d JOIN pt_occurrence o USING(scope_key,task_id)
      WHERE d.scope_key=? AND d.deleted_ms IS NULL AND json_extract(d.config,'$.template')=?
      AND (json_extract(d.config,'$.repeat')='repeat' OR o.state='active') LIMIT 1`).get(scope.key,rule.template);
    if (duplicate) throw new TaskError(409,'state_conflict','template_already_active');
    const taskId=id('task');
    this.db.prepare('INSERT INTO pt_definition(scope_key,task_id,version,config,created_ms,updated_ms) VALUES(?,?,1,?,?,?)').run(scope.key,taskId,JSON.stringify(rule),now,now);
    this.addPeriod(scope,taskId,1,rule,periodStart(rule.template,now));
    this.refresh(scope,now);
    return {item:present(this.rows(scope,'AND o.task_id=?',[taskId])[0]),wallet:this.wallet(scope)};
  }
  private editable(scope:TaskScope,task:string,occurrence:string,version:unknown) {
    const row=this.item(scope,task,occurrence);
    if (row.state!=='active') throw lockError();
    if (typeof version!=='number' || !Number.isSafeInteger(version) || version<0) throw invalid('invalid_expected_version');
    if (version!==row.definition_version) throw new TaskError(409,'version_conflict','definition_version_mismatch');
    return row;
  }
  edit(scope:TaskScope,task:string,occurrence:string,version:unknown,patch:Record<string,unknown>,now:number) {
    this.editable(scope,task,occurrence,version);
    const def=this.db.prepare('SELECT config,version FROM pt_definition WHERE task_id=? AND scope_key=?').get(task,scope.key)!;
    const rule=ruleFrom(patch,JSON.parse(String(def.config)));
    const config=JSON.stringify(rule), next=Number(def.version)+1;
    this.db.prepare('UPDATE pt_definition SET version=?,updated_ms=?,config=? WHERE scope_key=? AND task_id=?').run(next,now,config,scope.key,task);
    this.db.prepare('UPDATE pt_occurrence SET rule_version=?,config=? WHERE scope_key=? AND occurrence_id=?').run(next,config,scope.key,occurrence);
    this.refresh(scope,now);
    return {item:this.item(scope,task,occurrence),wallet:this.wallet(scope)};
  }
  remove(scope:TaskScope,task:string,occurrence:string,version:unknown,now:number) {
    this.editable(scope,task,occurrence,version);
    this.db.prepare('UPDATE pt_definition SET deleted_ms=?,updated_ms=? WHERE task_id=? AND scope_key=?').run(now,now,task,scope.key);
    this.refresh(scope,now);
    return {task_id:task,occurrence_id:occurrence,deleted_at_ms:now};
  }
  confirm(scope:TaskScope,task:string,occurrence:string) {
    const item=this.item(scope,task,occurrence);
    if (!item.settlement_id && item.state!=='awaiting_confirmation') throw new TaskError(409,'state_conflict','occurrence_not_eligible');
    const settlement=item.settlement_id ?? id('settle');
    if (!item.settlement_id) this.db.prepare(`UPDATE pt_occurrence SET state='pending_payment',settlement_id=? WHERE scope_key=? AND occurrence_id=?`).run(settlement,scope.key,occurrence);
    return {settlement_id:settlement,task_id:task,occurrence_id:occurrence,state:item.settlement_id?item.state:'pending_payment',
      currency:'C-FAMILY-001',amount:item.reward_coins,wallet:this.wallet(scope)};
  }
  recordReceived(scope:TaskScope,taskId:string,version:number) {
    if (!Number.isInteger(version)||version<1) return false;
    return !!this.db.prepare(`UPDATE pt_definition SET received_version=MAX(COALESCE(received_version,0),?)
      WHERE scope_key=? AND task_id=? AND version>=?`).run(version,scope.key,taskId,version).changes;
  }
  recordPaid(scope:TaskScope,task:string,occurrence:string,settlement:string,postSnapshotId:string,appliedAtMs:number) {
    return !!this.db.prepare(`UPDATE pt_occurrence SET state='paid',post_snapshot_id=?,applied_ms=? WHERE
      scope_key=? AND task_id=? AND occurrence_id=? AND settlement_id=? AND (state='pending_payment'
      OR (state='paid' AND post_snapshot_id=? AND applied_ms=?))`).run(postSnapshotId,appliedAtMs,scope.key,task,occurrence,settlement,postSnapshotId,appliedAtMs).changes;
  }
}
let singleton:TaskStore|undefined;
export const taskStore=()=>singleton??=new TaskStore(process.env.PARENT_TASKS_DB_PATH??'./data/parent-tasks.db');
