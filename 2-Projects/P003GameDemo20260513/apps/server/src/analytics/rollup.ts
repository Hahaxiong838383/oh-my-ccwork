import { AnalyticsStore,AnalyticsRollupBudgetExceeded,cstDay,DAY_MS } from './store.js';
type Fact={device_key:string;event_name:string;session_digest:string;clock_suspicious:number;semantic_json:string;received_at_ms:number};
export type RollupBudget={maxFactsPerDay:number;maxDayMs:number};
export type RollupStatus={attempted_days:number;rebuilt_days:number;failed_days:{dimension:string;day:string;reason:"budget_exceeded"|"storage_unavailable"}[];remaining_dirty_days:number;partial:boolean};
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
function summarizeFacts(facts:Iterable<Fact>,started:number,budget:RollupBudget,onDevice:(key:string,result:ReturnType<typeof summary>)=>void){
  const global=newCounts();let current:string|null=null,individual=newCounts(),sessions=new Set<string>(),rewards=new Set<string>(),devices=0,totalSessions=0,totalRewards=0;
  const checkBudget=()=>{if(global.facts>budget.maxFactsPerDay||performance.now()-started>budget.maxDayMs)throw new AnalyticsRollupBudgetExceeded();};
  const finishDevice=()=>{
    if(current===null)return;checkBudget();
    onDevice(current,summary(individual,1,sessions.size,rewards.size));
    // Keys are scoped to the device, so global distinct counts are sums of device counts.
    devices++;totalSessions+=sessions.size;totalRewards+=rewards.size;
  };
  for(const fact of facts){
    if(current!==fact.device_key){finishDevice();current=fact.device_key;individual=newCounts();sessions=new Set();rewards=new Set();}
    const semantic=JSON.parse(fact.semantic_json) as Record<string,unknown>; // Exactly once per fact.
    addFact(global,fact,semantic);addFact(individual,fact,semantic);
    if(fact.event_name==='app.session_started')sessions.add(fact.session_digest);
    if(fact.event_name==='g1.reward_granted'&&semantic.reward_instance_digest)rewards.add(String(semantic.reward_instance_digest));
    if(global.facts>budget.maxFactsPerDay||global.facts%256===0)checkBudget();
  }
  finishDevice();checkBudget();
  // Only the current device's distinct sets are retained, never raw fact arrays or all-device sets.
  return summary(global,devices,totalSessions,totalRewards);
}
export function rollupDirtyDays(store:AnalyticsStore,now=Date.now(),limit=16,budget?:RollupBudget):number{
  return rollupDirtyDaysWithStatus(store,now,limit,budget).rebuilt_days;
}
export function rollupDirtyDaysWithStatus(store:AnalyticsStore,now=Date.now(),limit=16,budget:RollupBudget={maxFactsPerDay:1_000_000,maxDayMs:30_000}):RollupStatus{
  if(!Number.isInteger(budget.maxFactsPerDay)||budget.maxFactsPerDay<1||budget.maxFactsPerDay>1_000_000||!Number.isInteger(budget.maxDayMs)||budget.maxDayMs<1||budget.maxDayMs>30_000)throw new Error('INVALID_ROLLUP_BUDGET');
  const dirty=store.db.prepare('SELECT d.dimension,d.day FROM analytics_dirty_day d LEFT JOIN analytics_rollup_retry r ON r.dimension=d.dimension AND r.day=d.day ORDER BY coalesce(r.last_attempt_ms,0),d.day,d.dimension LIMIT ?').all(Math.max(1,Math.min(180,limit))) as {dimension:string;day:string}[];
  const status:RollupStatus={attempted_days:dirty.length,rebuilt_days:0,failed_days:[],remaining_dirty_days:0,partial:false};
  for(const {dimension,day} of dirty){
    try{
      store.transaction(()=>{
        const started=performance.now();
        store.db.prepare('DELETE FROM analytics_device_day WHERE dimension=? AND day=?').run(dimension,day);
        const insertDevice=store.db.prepare('INSERT INTO analytics_device_day VALUES (?,?,?,?,?,?,?)');
        const result=summarizeFacts(store.db.prepare('SELECT * FROM analytics_rollup_fact WHERE dimension=? AND day=? ORDER BY device_key,received_at_ms,id_digest').iterate(dimension,day) as Iterable<Fact>,started,budget,(key,individual)=>{
          insertDevice.run(dimension,day,key,individual.event_count,individual.sessions,individual.data_cutoff_ms,JSON.stringify({...individual,updated_at_ms:now}));
        });
        store.db.prepare('INSERT INTO analytics_day VALUES (?,?,?,?) ON CONFLICT(dimension,day) DO UPDATE SET summary_json=excluded.summary_json,updated_at_ms=excluded.updated_at_ms').run(dimension,day,JSON.stringify(result),now);
        if(performance.now()-started>budget.maxDayMs)throw new AnalyticsRollupBudgetExceeded();
        store.db.prepare('DELETE FROM analytics_dirty_day WHERE dimension=? AND day=?').run(dimension,day);
        store.db.prepare('DELETE FROM analytics_rollup_retry WHERE dimension=? AND day=?').run(dimension,day);
      });
      status.rebuilt_days++;
    }catch(error){
      status.failed_days.push({dimension,day,reason:error instanceof AnalyticsRollupBudgetExceeded?'budget_exceeded':'storage_unavailable'});
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
function pruneDailyTable(store:AnalyticsStore,table:string,cutoff:string,limit:number):void{
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
}
export function pruneAnalytics(store:AnalyticsStore,now=Date.now(),chunk=1000):{events:number;batches:number}{
  const bounded=Math.max(1,Math.min(5000,chunk)),rawCutoff=now-14*DAY_MS,dailyCutoff=cstDay(now-90*DAY_MS);
  return store.transaction(()=>{
    const events=Number(store.db.prepare('DELETE FROM analytics_event WHERE rowid IN (SELECT rowid FROM analytics_event WHERE received_at_ms<? LIMIT ?)').run(rawCutoff,bounded).changes);
    const old=store.db.prepare('SELECT attempt_id FROM analytics_batch WHERE received_at_ms<? LIMIT ?').all(rawCutoff,bounded) as {attempt_id:string}[];
    for(const {attempt_id} of old){store.db.prepare('DELETE FROM analytics_settlement WHERE attempt_id=?').run(attempt_id);store.db.prepare('DELETE FROM analytics_batch WHERE attempt_id=?').run(attempt_id);}
    for(const table of ['analytics_rollup_fact','analytics_day','analytics_device_day','analytics_dirty_day','analytics_rollup_retry'])pruneDailyTable(store,table,dailyCutoff,bounded);
    return {events,batches:old.length};
  });
}
