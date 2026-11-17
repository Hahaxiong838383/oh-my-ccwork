/** Run only against an offline, backed-up database. No runtime startup migration. */
import {resolve,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {installArkHistoryIndexes} from '../src/ark/history-indexes.js';
const path=process.argv[2];
assert(path&&isAbsolute(path)&&existsSync(path)&&process.argv[3]==='--offline-reviewed','usage: ark-history-indexes.ts /absolute/existing/analytics.db --offline-reviewed (stop writers and preserve backup first)');
const db=new DatabaseSync(resolve(path));
try{db.exec('PRAGMA busy_timeout=0');console.log(JSON.stringify(installArkHistoryIndexes(db)));}finally{db.close();}
