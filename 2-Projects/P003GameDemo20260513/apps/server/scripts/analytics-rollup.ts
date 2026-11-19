import { AnalyticsStore } from '../src/analytics/store.js';
import { rollupDirtyDaysWithStatus,pruneAnalytics,type RollupStatus } from '../src/analytics/rollup.js';
const path=process.env.ANALYTICS_DB_PATH;
if(!path){console.error('[analytics-maintenance] MISSING_ANALYTICS_DB_PATH');process.exit(1);}
let store:AnalyticsStore|undefined,rollup:RollupStatus|undefined,pruned:ReturnType<typeof pruneAnalytics>|undefined;
let rollupError:string|undefined,pruneError:string|undefined;
try{
  store=new AnalyticsStore(path);
  // Commit one bounded TTL chunk before any potentially long aggregation.
  // External timeout/kill during rollup cannot skip already completed pruning.
  try{pruned=pruneAnalytics(store,Date.now(),1000);}catch{pruneError='ANALYTICS_PRUNE_FAILED';}
  try{rollup=rollupDirtyDaysWithStatus(store,Date.now(),16,{maxFactsPerDay:Number(process.env.ANALYTICS_ROLLUP_MAX_FACTS_PER_DAY??1_000_000),maxDayMs:Number(process.env.ANALYTICS_ROLLUP_MAX_DAY_MS??30_000)});}
  catch{rollupError='ANALYTICS_ROLLUP_FAILED';}
}catch{rollupError='ANALYTICS_STORAGE_UNAVAILABLE';}
finally{store?.close();}
// Partial aggregation is an executed bounded maintenance run; preserve JSON status for the scheduler.
// Fatal storage/metadata/prune failures return nonzero, but pruning has already been independently attempted.
console.log(JSON.stringify({ok:!rollupError&&!pruneError&&!rollup?.partial,partial:rollup?.partial??false,rebuilt_days:rollup?.rebuilt_days??0,rollup,pruned,rollup_error:rollupError,prune_error:pruneError}));
if(rollupError||pruneError)process.exitCode=1;
