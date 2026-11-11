import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'mini008-usage-perf-'));process.env.TELEMETRY_DB_PATH=join(dir,'telemetry.db');
const {telemetryStore,dayOf}=await import(pathToFileURL(join(process.env.SERVER_UNDER_TEST!,'src/telemetry-store.ts')).href);
const db=new DatabaseSync(process.env.TELEMETRY_DB_PATH);const now=Date.now();
db.exec('BEGIN');const stmt=db.prepare('INSERT INTO device_telemetry_event VALUES (?,?,?,?,?,?,?,?,?,?)');
for(let i=0;i<43200;i++){const end=now-i*60000;stmt.run('synthetic-perf-device','f'+i,'focus_segment',end,JSON.stringify({start_ms:end-60000,end_ms:end}),'hash'+i,1,end+100,100,'');}
for(let i=0;i<172800;i++)stmt.run('synthetic-perf-device','p'+i,'posture_round',now-i*15000,'{"result":"correct"}','p'+i,1,now-i*15000,0,'');
db.exec('COMMIT');const times=[];for(let i=0;i<25;i++){const t=performance.now();const r=telemetryStore.usageRange('synthetic-perf-device',dayOf(now-6*86400000),dayOf(now));if(r.length!==7)throw Error('bad range');times.push(performance.now()-t);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({scope:'isolated desktop, 30d continuous 60s segments plus 4x posture, one device',rows:216000,samples:times.length,p50_ms:times[12],p95_ms:times[23],max_ms:times[24],db:dir}));db.close();
