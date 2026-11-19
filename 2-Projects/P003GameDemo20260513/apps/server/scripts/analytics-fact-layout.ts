import {DatabaseSync} from 'node:sqlite';
import {isAbsolute} from 'node:path';
import {statSync} from 'node:fs';
import {configureAnalyticsWriter} from '../src/analytics/sqlite-policy.mjs';
import {factLayout,migrateFactLayout} from '../src/analytics/fact-layout.js';

// Stop ingest and maintenance writers, back up DB/WAL/SHM, then run --apply.
// Check is read-only and never creates a missing database. No automatic migration on startup.
const args=process.argv.slice(2),path=process.env.ANALYTICS_DB_PATH;
if(args.length!==1||!['--check','--apply'].includes(args[0])||!path||!isAbsolute(path))throw new Error('USAGE: ANALYTICS_DB_PATH=/absolute/path node --import tsx scripts/analytics-fact-layout.ts --check|--apply');
if(!statSync(path).isFile())throw new Error('ANALYTICS_DATABASE_FILE_REQUIRED');
const preflight=new DatabaseSync(path,{readOnly:true});
try{factLayout(preflight);}finally{preflight.close();}
const apply=args[0]==='--apply',db=new DatabaseSync(path,{readOnly:!apply,open:false});
db.open();
try{
 if(apply){factLayout(db);configureAnalyticsWriter(db);db.exec('PRAGMA cache_size=-65536');console.log(JSON.stringify({ok:true,...migrateFactLayout(db)}));}
 else console.log(JSON.stringify({ok:true,layout:factLayout(db),rows:Number(db.prepare('SELECT count(*) n FROM analytics_rollup_fact').get()!.n)}));
}finally{db.close();}
