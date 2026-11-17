import { AnalyticsStore,AnalyticsRollupBudgetExceeded,AnalyticsStorageUnavailable,cstDay,DAY_MS } from './store.js';
import {pruneAnalyticsTiers} from './tiers.js';
import {hasRollupPrefixIndex,ROLLUP_PREFIX_INDEX} from './rollup-index.js';
type Fact={fact_rowid:number;device_key:string;event_name:string;session_digest:string;clock_suspicious:number;semantic_json:string;received_at_ms:number};
export type RollupBudget={maxFactsPerDay:number;maxDayMs:number;maxRunMs?:number};
export type RollupStatus={attempted_days:number;rebuilt_days:number;failed_days:{dimension:string;day:string;reason:"budget_exceeded"|"storage_unavailable"|"concurrent_write"}[];remaining_dirty_days:number;partial:boolean};
type Counts={names:Record<string,number>;failures:Map<string,number>;suspicious:number;gm:number;facts:number;last:number};
const newCounts=():Counts=>({names:{},failures:new Map(),suspicious:0,gm:0,facts:0,last:0});
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
function addFact(counts:Counts,fact:Fact,semantic:Record<string,unknown>){
  counts.facts++;counts.last=Math.max(counts.last,fact.received_at_ms);counts.names[fact.event_name]=(counts.names[fact.event_name]??0)+1;
  counts.suspicious+=fact.clock_suspicious;if(semantic.gm_override===true)counts.gm++;
  if(fact.event_name==='g1.command_failed'){const key=JSON.stringify([semantic.command??'',semantic.error_code??'']);counts.failures.set(key,(counts.failures.get(key)??0)+1);}
}
function summary(counts:Counts,devices:number,sessions:number,rewards:number){
  const {names,failures}=counts;
  const select=(prefixes:string[])=>Object.fromEntries(Object.entries(names).filter(([n])=>prefixes.some(p=>n.startsWith(p))));
  return {event_count:counts.facts,active_devices:devices,sessions,event_counts:names,clock_suspicious_events:counts.suspicious,explicit_gm_events:counts.gm,unclassified_traffic_events:counts.facts-counts.gm,reward_grant_events:names['g1.reward_granted']??0,unique_reward_instances:rewards,
    groups:{activity:select(['app.']),g1_flow:select(['g1.experience','g1.phase','g1.screen','g1.semantic','g1.runtime_command']),logical_day_ecotank:select(['g1.logical','g1.progress','g1.route','g1.ecotank','g1.historical']),rewards_makeup:select(['g1.reward','g1.gift','g1.makeup']),settings:select(['settings.']),voice_state:select(['voice.']),command_failures:[...failures].map(([key,count])=>{const [command,error_code]=JSON.parse(key);return {command,error_code,count};}).sort((a,b)=>b.count-a.count||compareText(a.command,b.command)||compareText(a.error_code,b.error_code)).slice(0,100)},data_cutoff_ms:counts.last};
}
type StoredDevice={counts:Omit<Counts,'failures'>&{failures:[string,number][]};sessions:number;rewards:number};
class ConcurrentRollupWrite extends Error {}
const lockBackoff=new Int32Array(new SharedArrayBuffer(4));
const isBusy=(error:unknown)=>error instanceof AnalyticsStorageUnavailable?error.busy:[5,6].includes(Number((error as {errcode?:number})?.errcode)&255);
function waitForWriter(error:unknown,check:()=>void){
  if(!isBusy(error))throw error;
  check();
  // Only the standalone maintenance process waits here. Reuse the existing
  // day deadline, release every transaction, and avoid spinning on a busy DB.
  Atomics.wait(lockBackoff,0,0,10);
  check();
}
function retryWriter<T>(run:()=>T,check:()=>void):T{
  for(;;){try{return run();}catch(error){waitForWriter(error,check);}}
}
type Source={revision:number;mutation:number};
type Stage=Source&{folded_rowid:number;summary_json:string};
const sourceState=(store:AnalyticsStore,dimension:string,day:string,key:string):Source=>(store.db.prepare('SELECT revision,mutation FROM analytics_rollup_source WHERE dimension=? AND day=? AND device_key=?').get(dimension,day,key) as Source|undefined)??{revision:0,mutation:0};
const readStage=(store:AnalyticsStore,dimension:string,day:string,key:string)=>store.db.prepare('SELECT revision,mutation,folded_rowid,summary_json FROM analytics_rollup_device_stage WHERE dimension=? AND day=? AND device_key=?').get(dimension,day,key) as Stage|undefined;
function deviceKeys(store:AnalyticsStore,dimension:string,day:string):string[]{
  // Seek one key at a time in the existing fact PK: no DISTINCT full-day scan.
  const keys=new Set((store.db.prepare('SELECT device_key FROM analytics_rollup_source WHERE dimension=? AND day=? ORDER BY device_key').all(dimension,day) as {device_key:string}[]).map(r=>r.device_key));
  const first=store.db.prepare('SELECT device_key FROM analytics_rollup_fact WHERE dimension=? AND day=? ORDER BY device_key LIMIT 1');
  const next=store.db.prepare('SELECT device_key FROM analytics_rollup_fact WHERE dimension=? AND day=? AND device_key>? ORDER BY device_key LIMIT 1');
  let row=first.get(dimension,day) as {device_key:string}|undefined;
  while(row){keys.add(row.device_key);if(keys.size>1000)throw new AnalyticsRollupBudgetExceeded();row=next.get(dimension,day,row.device_key) as typeof row;}
  if(keys.size>1000)throw new AnalyticsRollupBudgetExceeded();
  return [...keys].sort(compareText);
}
function buildDevice(store:AnalyticsStore,dimension:string,day:string,key:string,base:Stage|undefined,check:()=>void,maxFacts:number,paged:boolean){
  const previous=base?JSON.parse(base.summary_json) as StoredDevice:undefined;
  const counts:Counts=previous?{...previous.counts,failures:new Map(previous.counts.failures)}:newCounts();
  const sessions=new Set<string>(),rewards=new Set<string>();let cursor=base?.folded_rowid??0,rows=0,more=false;
  // Rowids are stable under supported writes/migrations. Any delete/update of
  // this device invalidates its prefix, including deletion followed by rowid reuse.
  // The old received-time cursor would miss a late event when the clock moves back.
  const sql='SELECT rowid fact_rowid,device_key,event_name,session_digest,clock_suspicious,semantic_json,received_at_ms FROM analytics_rollup_fact'+(paged?' INDEXED BY '+ROLLUP_PREFIX_INDEX:'')+' WHERE dimension=? AND day=? AND device_key=? AND rowid>? ORDER BY '+(paged?'rowid LIMIT 513':'received_at_ms,id_digest');
  for(const fact of store.db.prepare(sql).iterate(dimension,day,key,cursor) as Iterable<Fact>){
    if(paged&&rows===512){more=true;break;}rows++;
    const semantic=JSON.parse(fact.semantic_json) as Record<string,unknown>;
    addFact(counts,fact,semantic);cursor=Math.max(cursor,fact.fact_rowid);
    if(fact.event_name==='app.session_started')sessions.add(fact.session_digest);
    if(fact.event_name==='g1.reward_granted'&&semantic.reward_instance_digest)rewards.add(String(semantic.reward_instance_digest));
    if(counts.facts>maxFacts)throw new AnalyticsRollupBudgetExceeded();
    if(counts.facts%256===0)check();
  }
  check();
  return {cursor,more,data:{counts:{...counts,failures:[...counts.failures]},sessions:previous?.sessions??0,rewards:previous?.rewards??0} as StoredDevice,sessions,rewards};
}
function rebuildDay(store:AnalyticsStore,dimension:string,day:string,now:number,budget:RollupBudget){
  const started=performance.now();
  const check=()=>{if(performance.now()-started>budget.maxDayMs)throw new AnalyticsRollupBudgetExceeded();};
  const paged=hasRollupPrefixIndex(store.db);
  const keys=store.readSnapshot(()=>deviceKeys(store,dimension,day));
  let facts=0,conflict=false;
  for(const key of keys){
   for(;;){
    check();
    try{
    const computed=store.readSnapshot(()=>{
      const source=sourceState(store,dimension,day,key),stage=readStage(store,dimension,day,key);
      const base=stage?.mutation===source.mutation?stage:undefined;
      if(base&&base.revision===source.revision)return {source,stage,base,data:JSON.parse(base.summary_json) as StoredDevice,cached:true as const};
      return {source,stage,base,...buildDevice(store,dimension,day,key,base,check,budget.maxFactsPerDay-facts,paged),cached:false as const};
    });
    if(facts+computed.data.counts.facts>budget.maxFactsPerDay)throw new AnalyticsRollupBudgetExceeded();
    check();
    if(!computed.cached){
      // New inserts can follow this snapshot without destroying its valid
      // prefix. Mutations invalidate it; a second maintainer cannot apply it twice.
      const saved=store.transaction(()=>{
        const source=sourceState(store,dimension,day,key),stage=readStage(store,dimension,day,key);
        if(source.mutation!==computed.source.mutation||stage?.folded_rowid!==computed.stage?.folded_rowid||stage?.revision!==computed.stage?.revision)return false;
        if(!computed.base)store.db.prepare('DELETE FROM analytics_rollup_distinct WHERE dimension=? AND day=? AND device_key=?').run(dimension,day,key);
        const remember=store.db.prepare('INSERT OR IGNORE INTO analytics_rollup_distinct VALUES (?,?,?,?,?)');
        for(const digest of computed.sessions)computed.data.sessions+=Number(remember.run(dimension,day,key,'session',digest).changes);
        for(const digest of computed.rewards)computed.data.rewards+=Number(remember.run(dimension,day,key,'reward',digest).changes);
        store.db.prepare('INSERT OR IGNORE INTO analytics_rollup_source VALUES (?,?,?,0,0)').run(dimension,day,key);
        store.db.prepare('INSERT INTO analytics_rollup_device_stage VALUES (?,?,?,?,?,?,?) ON CONFLICT(dimension,day,device_key) DO UPDATE SET revision=excluded.revision,mutation=excluded.mutation,folded_rowid=excluded.folded_rowid,summary_json=excluded.summary_json').run(dimension,day,key,computed.more?-1:computed.source.revision,computed.source.mutation,computed.cursor,JSON.stringify(computed.data));
        check();return true;
      });
      if(!saved){conflict=true;break;}
      if(computed.more)continue;
    }
    facts+=computed.data.counts.facts;break;
    }catch(error){
      // Recompute from the last committed stage: a failed COMMIT may have
      // mutated the temporary distinct counters before SQLite rolled back.
      waitForWriter(error,check);
    }
   }
  }
  if(conflict)throw new ConcurrentRollupWrite();
  check();
  // Publish a whole day only when every device cache matches its authoritative
  // source revision. A newly arriving device has no cache and also blocks this.
  const published=retryWriter(()=>store.transaction(()=>{
    const rows=store.db.prepare('SELECT s.device_key,s.revision,s.mutation,c.revision cached_revision,c.mutation cached_mutation,c.summary_json FROM analytics_rollup_source s LEFT JOIN analytics_rollup_device_stage c ON c.dimension=s.dimension AND c.day=s.day AND c.device_key=s.device_key WHERE s.dimension=? AND s.day=? ORDER BY s.device_key').all(dimension,day) as {device_key:string;revision:number;mutation:number;cached_revision:number|null;cached_mutation:number|null;summary_json:string|null}[];
    if(rows.some(r=>r.cached_revision!==r.revision||r.cached_mutation!==r.mutation||r.summary_json===null))return false;
    if(rows.length>1000)throw new AnalyticsRollupBudgetExceeded();
    const global=newCounts();let devices=0,sessions=0,rewards=0;
    const summaries:{key:string;individual:ReturnType<typeof summary>}[]=[];
    for(const row of rows){
      const part=JSON.parse(row.summary_json!) as StoredDevice,c={...part.counts,failures:new Map(part.counts.failures)};
      if(c.facts===0)continue;
      devices++;sessions+=part.sessions;rewards+=part.rewards;
      global.facts+=c.facts;global.last=Math.max(global.last,c.last);global.gm+=c.gm;global.suspicious+=c.suspicious;
      if(global.facts>budget.maxFactsPerDay)throw new AnalyticsRollupBudgetExceeded();
      for(const [name,count] of Object.entries(c.names))global.names[name]=(global.names[name]??0)+count;
      // Keep all failure keys until this merge; per-device top100 would lose
      // keys that enter the global top100 only after counts are combined.
      for(const [key,count] of c.failures)global.failures.set(key,(global.failures.get(key)??0)+count);
      summaries.push({key:row.device_key,individual:summary(c,1,part.sessions,part.rewards)});check();
    }
    store.db.prepare('DELETE FROM analytics_device_day WHERE dimension=? AND day=?').run(dimension,day);
    const insert=store.db.prepare('INSERT INTO analytics_device_day VALUES (?,?,?,?,?,?,?)');
    for(const {key,individual} of summaries)insert.run(dimension,day,key,individual.event_count,individual.sessions,individual.data_cutoff_ms,JSON.stringify({...individual,updated_at_ms:now}));
    store.db.prepare('INSERT INTO analytics_day VALUES (?,?,?,?) ON CONFLICT(dimension,day) DO UPDATE SET summary_json=excluded.summary_json,updated_at_ms=excluded.updated_at_ms').run(dimension,day,JSON.stringify(summary(global,devices,sessions,rewards)),now);
    check();
    store.db.prepare('DELETE FROM analytics_dirty_day WHERE dimension=? AND day=?').run(dimension,day);
    store.db.prepare('DELETE FROM analytics_rollup_retry WHERE dimension=? AND day=?').run(dimension,day);
    return true;
  }),check);
  if(!published)throw new ConcurrentRollupWrite();
}
export function rollupDirtyDays(store:AnalyticsStore,now=Date.now(),limit=16,budget?:RollupBudget):number{
  return rollupDirtyDaysWithStatus(store,now,limit,budget).rebuilt_days;
}
export function rollupDirtyDaysWithStatus(store:AnalyticsStore,now=Date.now(),limit=16,budget:RollupBudget={maxFactsPerDay:1_000_000,maxDayMs:30_000}):RollupStatus{
  if(!Number.isInteger(budget.maxFactsPerDay)||budget.maxFactsPerDay<1||budget.maxFactsPerDay>1_000_000||!Number.isInteger(budget.maxDayMs)||budget.maxDayMs<1||budget.maxDayMs>30_000)throw new Error('INVALID_ROLLUP_BUDGET');
  const runStarted=performance.now(),runBudget=budget.maxRunMs??150_000;
  if(!Number.isInteger(runBudget)||runBudget<1||runBudget>150_000)throw new Error('INVALID_ROLLUP_BUDGET');
  const dirty=store.db.prepare('SELECT d.dimension,d.day FROM analytics_dirty_day d LEFT JOIN analytics_rollup_retry r ON r.dimension=d.dimension AND r.day=d.day ORDER BY coalesce(r.last_attempt_ms,0),d.day,d.dimension LIMIT ?').all(Math.max(1,Math.min(180,limit))) as {dimension:string;day:string}[];
  const status:RollupStatus={attempted_days:0,rebuilt_days:0,failed_days:[],remaining_dirty_days:0,partial:false};
  for(const {dimension,day} of dirty){
    // Stop between days: <=150s + one bounded 30s day, below the 240s wrapper.
    if(performance.now()-runStarted>=runBudget)break;
    status.attempted_days++;
    try{
      // Bounded TTL can leave an expired day's newly marked dirty key behind.
      // Never republish the partially deleted facts as a complete historical day.
      if(day<cstDay(now-90*DAY_MS)){
        store.transaction(()=>{
          store.db.prepare('DELETE FROM analytics_dirty_day WHERE dimension=? AND day=?').run(dimension,day);
          store.db.prepare('DELETE FROM analytics_rollup_retry WHERE dimension=? AND day=?').run(dimension,day);
        });
        continue;
      }
      rebuildDay(store,dimension,day,now,budget);
      status.rebuilt_days++;
    }catch(error){
      status.failed_days.push({dimension,day,reason:error instanceof AnalyticsRollupBudgetExceeded?'budget_exceeded':(error instanceof ConcurrentRollupWrite||(error instanceof AnalyticsStorageUnavailable&&error.busy)||(Number((error as {errcode?:number}).errcode)&255)===5?'concurrent_write':'storage_unavailable')});
      try{store.db.prepare('INSERT INTO analytics_rollup_retry VALUES (?,?,?) ON CONFLICT(dimension,day) DO UPDATE SET last_attempt_ms=excluded.last_attempt_ms').run(dimension,day,now);}catch{}
    }
  }
  status.remaining_dirty_days=Number((store.db.prepare('SELECT count(*) n FROM analytics_dirty_day').get() as {n:number}).n);
  status.partial=status.failed_days.length>0||status.remaining_dirty_days>0;
  store.transaction(()=>{
    const record=store.db.prepare('INSERT INTO analytics_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    record.run('last_rollup_attempt_ms',String(now));record.run('last_rollup_status',status.partial?'partial':'complete');
    record.run('last_rollup_failed_days',String(status.failed_days.length));record.run('last_rollup_remaining_dirty_days',String(status.remaining_dirty_days));
    if(status.partial)record.run('last_rollup_partial_ms',String(now));else record.run('last_rollup_success_ms',String(now));
  });
  return status;
}
function pruneDailyTable(store:AnalyticsStore,table:string,cutoff:string,limit:number):number{
  // All callers use the fixed daily-table list below. Its existing keys start with dimension,day.
  const first=store.db.prepare(`SELECT dimension FROM ${table} ORDER BY dimension LIMIT 1`);
  const next=store.db.prepare(`SELECT dimension FROM ${table} WHERE dimension>? ORDER BY dimension LIMIT 1`);
  const remove=store.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE dimension=? AND day<? LIMIT ?)`);
  let current=first.get() as {dimension:string}|undefined,remaining=limit;
  while(current&&remaining>0){
    const dimension=current.dimension;
    // LIMIT applies to this dimension; actual changes consume the one budget shared by the table.
    remaining-=Number(remove.run(dimension,cutoff,remaining).changes);
    // Seek past the saved key even if its last row was deleted. Empty/unknown dimensions are included.
    if(remaining>0)current=next.get(dimension) as {dimension:string}|undefined;
  }
  return limit-remaining;
}
export function pruneAnalytics(store:AnalyticsStore,now=Date.now(),chunk=1000):{events:number;batches:number}{
  const {events,batches}=pruneChunk(store,now,chunk,chunk);return {events,batches};
}
function pruneChunk(store:AnalyticsStore,now:number,chunk:number,batchChunk:number){
  const bounded=Math.max(1,Math.min(5000,chunk)),rawCutoff=now-14*DAY_MS,dailyCutoff=cstDay(now-90*DAY_MS);
  return store.transaction(()=>{
    const rawEvents=Number(store.db.prepare('DELETE FROM analytics_event WHERE rowid IN (SELECT rowid FROM analytics_event WHERE received_at_ms<? LIMIT ?)').run(rawCutoff,bounded).changes);
    const events=rawEvents+pruneAnalyticsTiers(store.db,now,bounded-rawEvents);
    const old=store.db.prepare('SELECT attempt_id FROM analytics_batch WHERE received_at_ms<? LIMIT ?').all(rawCutoff,Math.min(bounded,batchChunk)) as {attempt_id:string}[];
    for(const {attempt_id} of old){store.db.prepare('DELETE FROM analytics_transport WHERE attempt_id=?').run(attempt_id);store.db.prepare('DELETE FROM analytics_settlement WHERE attempt_id=?').run(attempt_id);store.db.prepare('DELETE FROM analytics_batch WHERE attempt_id=?').run(attempt_id);}
    const transportDays=Number(store.db.prepare('DELETE FROM analytics_transport_day WHERE rowid IN (SELECT rowid FROM analytics_transport_day WHERE day<? LIMIT ?)').run(dailyCutoff,bounded).changes);
    let facts=0,dailyRows=0;
    for(const table of ['analytics_rollup_fact','analytics_day','analytics_device_day','analytics_dirty_day','analytics_rollup_retry','analytics_rollup_device_stage','analytics_rollup_distinct','analytics_rollup_source']){const removed=pruneDailyTable(store,table,dailyCutoff,bounded);dailyRows+=removed;if(table==='analytics_rollup_fact')facts=removed;}
    return {events,batches:old.length,facts,changed:events+old.length+transportDays+dailyRows};
  });
}

// 300 × 10 facts / 5min = 864,000 facts/day; max 1 batch (<=200
// settlements) per transaction. Pause permits waiting ingestion writers to run.
export const PRUNE_CYCLE={maxChunks:300,chunk:10,batchChunk:1,maxMs:30000,pauseMs:10} as const;
export async function pruneAnalyticsCycle(store:AnalyticsStore,now=Date.now()){
 const start=performance.now(),result={events:0,batches:0,facts:0,chunks:0,elapsed_ms:0,max_transaction_ms:0,budget_exhausted:false};
 let empty=false;
 for(let i=0;i<PRUNE_CYCLE.maxChunks&&performance.now()-start<PRUNE_CYCLE.maxMs;i++){
  const t=performance.now(),part=pruneChunk(store,now,PRUNE_CYCLE.chunk,PRUNE_CYCLE.batchChunk);
  result.max_transaction_ms=Math.max(result.max_transaction_ms,performance.now()-t);
  result.events+=part.events;result.batches+=part.batches;result.facts+=part.facts;result.chunks++;
  if(part.changed===0){empty=true;break;}
  await new Promise(resolve=>setTimeout(resolve,PRUNE_CYCLE.pauseMs));
 }
 result.elapsed_ms=performance.now()-start;result.budget_exhausted=!empty;
 return result;
}
