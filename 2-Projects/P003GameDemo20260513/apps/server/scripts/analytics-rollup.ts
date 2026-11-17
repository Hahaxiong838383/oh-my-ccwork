import { AnalyticsStore } from '../src/analytics/store.js';
import { rollupDirtyDaysWithStatus,pruneAnalyticsCycle,type RollupStatus } from '../src/analytics/rollup.js';
const path=process.env.ANALYTICS_DB_PATH;
if(!path){console.error('[analytics-maintenance] MISSING_ANALYTICS_DB_PATH');process.exit(1);}
let store:AnalyticsStore|undefined,rollup:RollupStatus|undefined,pruned:Awaited<ReturnType<typeof pruneAnalyticsCycle>>|undefined;
let rollupError:string|undefined,pruneError:string|undefined;
let workStartedAt:number|undefined,workFinishedAt:number|undefined;
try{
  store=new AnalyticsStore(path);
  workStartedAt=Date.now();
  // Commit bounded short TTL transactions before aggregation.
  // External timeout/kill during rollup cannot skip already completed pruning.
  try{pruned=await pruneAnalyticsCycle(store,Date.now());}catch{pruneError='ANALYTICS_PRUNE_FAILED';}
  try{rollup=rollupDirtyDaysWithStatus(store,Date.now(),16,{maxFactsPerDay:Number(process.env.ANALYTICS_ROLLUP_MAX_FACTS_PER_DAY??1_000_000),maxDayMs:Number(process.env.ANALYTICS_ROLLUP_MAX_DAY_MS??30_000)});}
  catch{rollupError='ANALYTICS_ROLLUP_FAILED';}
}catch{rollupError='ANALYTICS_STORAGE_UNAVAILABLE';}
finally{workFinishedAt=Date.now();store?.close();}
// Partial aggregation is an executed bounded maintenance run; preserve JSON status for the scheduler.
// Fatal storage/metadata/prune failures return nonzero, but pruning has already been independently attempted.
console.log(JSON.stringify({ok:!rollupError&&!pruneError&&!rollup?.partial,partial:rollup?.partial??false,rebuilt_days:rollup?.rebuilt_days??0,rollup,pruned,rollup_error:rollupError,prune_error:pruneError,work_started_at_ms:workStartedAt,work_finished_at_ms:workFinishedAt}));
if(rollupError||pruneError)process.exitCode=1;
