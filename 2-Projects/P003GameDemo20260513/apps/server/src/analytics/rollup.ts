import { AnalyticsStore,AnalyticsRollupBudgetExceeded,cstDay,DAY_MS } from './store.js';
type Fact={device_key:string;event_name:string;session_digest:string;clock_suspicious:number;semantic_json:string;received_at_ms:number};
export type RollupBudget={maxFactsPerDay:number;maxDayMs:number};
export type RollupStatus={attempted_days:number;rebuilt_days:number;failed_days:{dimension:string;day:string;reason:"budget_exceeded"|"storage_unavailable"}[];remaining_dirty_days:number;partial:boolean};
function summarizeFacts(facts:Iterable<Fact>,started:number,budget:RollupBudget){
  const names:Record<string,number>={},devices=new Map<string,{events:number;sessions:Set<string>;last:number}>(),sessions=new Set<string>(),failures=new Map<string,number>(),rewards=new Set<string>();
  let suspicious=0,gm=0,factCount=0,lastReceived=0;
  for(const fact of facts){
    factCount++;lastReceived=Math.max(lastReceived,fact.received_at_ms);
    if(factCount>budget.maxFactsPerDay||(factCount%256===0&&performance.now()-started>budget.maxDayMs))throw new AnalyticsRollupBudgetExceeded();
    names[fact.event_name]=(names[fact.event_name]??0)+1;
    const d=devices.get(fact.device_key)??{events:0,sessions:new Set<string>(),last:0};d.events++;d.last=Math.max(d.last,fact.received_at_ms);
    if(fact.event_name==='app.session_started'){sessions.add(fact.device_key+':'+fact.session_digest);d.sessions.add(fact.session_digest);}devices.set(fact.device_key,d);
    suspicious+=fact.clock_suspicious;const semantic=JSON.parse(fact.semantic_json);
    if(semantic.gm_override===true)gm++;
    if(fact.event_name==='g1.command_failed'){const key=JSON.stringify([semantic.command??'',semantic.error_code??'']);failures.set(key,(failures.get(key)??0)+1);}
    if(fact.event_name==='g1.reward_granted'&&semantic.reward_instance_digest)rewards.add(fact.device_key+':'+semantic.reward_instance_digest);
  }
  const select=(prefixes:string[])=>Object.fromEntries(Object.entries(names).filter(([n])=>prefixes.some(p=>n.startsWith(p))));
  return {devices,summary:{event_count:factCount,active_devices:devices.size,sessions:sessions.size,event_counts:names,clock_suspicious_events:suspicious,explicit_gm_events:gm,unclassified_traffic_events:factCount-gm,reward_grant_events:names['g1.reward_granted']??0,unique_reward_instances:rewards.size,
    groups:{activity:select(['app.']),g1_flow:select(['g1.experience','g1.phase','g1.screen','g1.semantic','g1.runtime_command']),logical_day_ecotank:select(['g1.logical','g1.progress','g1.route','g1.ecotank','g1.historical']),rewards_makeup:select(['g1.reward','g1.gift','g1.makeup']),settings:select(['settings.']),voice_state:select(['voice.']),command_failures:[...failures].map(([key,count])=>{const [command,error_code]=JSON.parse(key);return {command,error_code,count};}).sort((a,b)=>b.count-a.count).slice(0,100)},data_cutoff_ms:lastReceived}};
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
        const result=summarizeFacts(store.db.prepare('SELECT * FROM analytics_rollup_fact WHERE dimension=? AND day=? ORDER BY device_key,id_digest').iterate(dimension,day) as Iterable<Fact>,started,budget);
        store.db.prepare('INSERT INTO analytics_day VALUES (?,?,?,?) ON CONFLICT(dimension,day) DO UPDATE SET summary_json=excluded.summary_json,updated_at_ms=excluded.updated_at_ms').run(dimension,day,JSON.stringify(result.summary),now);
        store.db.prepare('DELETE FROM analytics_device_day WHERE dimension=? AND day=?').run(dimension,day);
        for(const [key,d] of result.devices){
          const individual=summarizeFacts(store.db.prepare('SELECT * FROM analytics_rollup_fact WHERE dimension=? AND day=? AND device_key=? ORDER BY id_digest').iterate(dimension,day,key) as Iterable<Fact>,started,budget);
          store.db.prepare('INSERT INTO analytics_device_day VALUES (?,?,?,?,?,?,?)').run(dimension,day,key,d.events,d.sessions.size,d.last,JSON.stringify({...individual.summary,updated_at_ms:now}));
        }
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
export function pruneAnalytics(store:AnalyticsStore,now=Date.now(),chunk=1000):{events:number;batches:number}{
  const bounded=Math.max(1,Math.min(5000,chunk)),rawCutoff=now-14*DAY_MS,dailyCutoff=cstDay(now-90*DAY_MS);
  return store.transaction(()=>{
    const events=Number(store.db.prepare('DELETE FROM analytics_event WHERE rowid IN (SELECT rowid FROM analytics_event WHERE received_at_ms<? LIMIT ?)').run(rawCutoff,bounded).changes);
    const old=store.db.prepare('SELECT attempt_id FROM analytics_batch WHERE received_at_ms<? LIMIT ?').all(rawCutoff,bounded) as {attempt_id:string}[];
    for(const {attempt_id} of old){store.db.prepare('DELETE FROM analytics_settlement WHERE attempt_id=?').run(attempt_id);store.db.prepare('DELETE FROM analytics_batch WHERE attempt_id=?').run(attempt_id);}
    for(const table of ['analytics_rollup_fact','analytics_day','analytics_device_day','analytics_dirty_day','analytics_rollup_retry'])store.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE day<? LIMIT ?)`).run(dailyCutoff,bounded);
    return {events,batches:old.length};
  });
}
