/** Offline, backed-up databases only. No startup index migration. */
import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {configureAnalyticsWriter} from '../src/analytics/sqlite-policy.mjs';
import {hasRollupPrefixIndex,installRollupPrefixIndex} from '../src/analytics/rollup-index.js';
const path=process.argv[2],mode=process.argv[3];
assert(path&&isAbsolute(path)&&existsSync(path)&&['--check','--offline-reviewed'].includes(mode),'usage: analytics-rollup-index.ts /absolute/existing/analytics.db --check|--offline-reviewed');
const db=new DatabaseSync(path,{readOnly:mode==='--check'});
try{
 if(mode==='--check')console.log(JSON.stringify({available:hasRollupPrefixIndex(db)}));
 else {configureAnalyticsWriter(db);db.exec('PRAGMA busy_timeout=0;PRAGMA cache_size=-65536');console.log(JSON.stringify(installRollupPrefixIndex(db)));}
}finally{db.close();}
