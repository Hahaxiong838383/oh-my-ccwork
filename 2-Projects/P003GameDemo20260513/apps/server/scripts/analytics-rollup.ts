import { AnalyticsStore } from '../src/analytics/store.js';
import { rollupDirtyDays,pruneAnalytics } from '../src/analytics/rollup.js';
const path=process.env.ANALYTICS_DB_PATH;
if(!path){console.error('[analytics-maintenance] MISSING_ANALYTICS_DB_PATH');process.exit(1);}
let store:AnalyticsStore|undefined;
try{
  store=new AnalyticsStore(path);
  const rebuilt=rollupDirtyDays(store,Date.now(),16);
  const pruned=pruneAnalytics(store,Date.now(),1000);
  console.log(JSON.stringify({ok:true,rebuilt_days:rebuilt,pruned}));
}catch{console.error('[analytics-maintenance] MAINTENANCE_FAILED');process.exitCode=1;}
finally{store?.close();}
