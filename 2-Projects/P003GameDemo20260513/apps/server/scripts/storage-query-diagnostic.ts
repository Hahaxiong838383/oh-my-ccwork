/** Isolated copy-only diagnostic: real HTTP/Ark queries against existing synthetic rows. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
import {AnalyticsStore} from '../src/analytics/store.js';
import {ArkStore} from '../src/ark/store.js';
import {createAnalyticsApp} from '../src/analytics/index.js';
import {startSharedQuery} from './storage-shared-query-client.js';
import {sqlProfiler} from './storage-sql-profile.js';
import {linuxResources} from './storage-load-resources.js';
const root=resolve(process.argv[2]??'');
assert(root.includes('/p003-t5-diag-')&&root===realpathSync(root));
assert(existsSync(join(root,'COPY-ONLY.json'))&&!existsSync(join(root,'DIAGNOSTIC.json')));
const config=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));assert(config.synthetic);
Object.assign(config,{receiver_pid:process.pid,continuous_ark:true});writeFileSync(join(root,'config.json'),JSON.stringify(config));
const path=join(root,'analytics.db'),store=new AnalyticsStore(path),ark=new ArkStore(join(root,'ark.db'));
const cacheKiB=Number(process.env.T5_DIAG_CACHE_KIB??65536);assert([65536,8192].includes(cacheKiB));
store.db.exec(`PRAGMA cache_size=-${cacheKiB}`);
// Only copied, stopped fixtures may be dirtied for a reproducible rebuild.
store.db.exec('INSERT OR IGNORE INTO analytics_dirty_day SELECT dimension,day FROM analytics_day');
const ids=Array.from({length:config.devices},(_,i)=>({sn:'BJP003999999'+String(i+1).padStart(8,'0'),account_id:'t5-synthetic-'+i,epoch:1}));
const secret=randomBytes(32).toString('hex');writeFileSync(join(root,'control.json'),'{"enabled":true}');
const reader={arkDeviceKey:(sn:string)=>createHash('sha256').update(sn).digest('hex'),readArkAuthorization:(sn:string)=>{const id=ids.find(i=>i.sn===sn),g=id&&ark.grant(id);return id&&g?{...id,not_before_ms:g.not_before_ms}:null;},readiness:()=>true};
const app=createAnalyticsApp({store,reader:reader as any,internalSecret:secret,authSecret:secret,controlPath:join(root,'control.json'),allowSubjects:ids.map(i=>i.sn)});
const profile=sqlProfiler([{name:'analytics',db:store.db},{name:'ark',db:ark.db}],sample=>appendFileSync(join(root,'sql-query-profile.jsonl'),JSON.stringify(sample)+'\n'));
const server=serve({fetch:request=>profile.run(request.headers.get('X-T5-Query-Id')??'warmup',async()=>{
 const start=performance.now(),received=Date.now(),r=await app.fetch(request);r.headers.set('X-T5-Service-Ms',String(performance.now()-start));r.headers.set('X-T5-Receiver-Pid',String(process.pid));
 appendFileSync(join(root,'shared-reader.jsonl'),JSON.stringify({received_at_ms:received,done_at_ms:Date.now(),query_id:request.headers.get('X-T5-Query-Id'),ms:performance.now()-start,status:r.status,receiver_pid:process.pid})+'\n');return r;
}),hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
const service=await startSharedQuery(root,'http://127.0.0.1:'+(server.address()as any).port,secret);
const resourceTimer=setInterval(()=>appendFileSync(join(root,'resources.jsonl'),JSON.stringify({at_ms:Date.now(),...linuxResources(root)})+'\n'),500);
const results:any[]=[];let maintenance:ReturnType<typeof spawn>|undefined;
try{
 results.push({name:'cold',exit:await service.query('diag-cold')});
 const start=Date.now();maintenance=spawn(process.execPath,['--import','tsx','scripts/analytics-rollup.ts'],{env:{...process.env,ANALYTICS_DB_PATH:path},stdio:['ignore','pipe','pipe']});
 maintenance.stdout.on('data',x=>appendFileSync(join(root,'maintenance.stdout'),x));maintenance.stderr.on('data',x=>appendFileSync(join(root,'maintenance.stderr'),x));
 const closed=once(maintenance,'exit');let done=false;closed.finally(()=>{done=true;});
 for(let i=0;i<15;i++){results.push({name:'mixed-'+i,exit:await service.query('diag-mixed-'+i)});if(done&&i>=2)break;}
 const [code,signal]=await closed;assert.equal(code,0);assert.equal(signal,null);
 writeFileSync(join(root,'DIAGNOSTIC.json'),JSON.stringify({scope:'COPY_ONLY_NO_UPLOAD_NO_BACKUP_NOT_ACCEPTANCE',cacheKiB,results,maintenance_start:start,maintenance_end:Date.now()},null,2));
}finally{clearInterval(resourceTimer);await service.stop();server.closeAllConnections();server.close();ark.close();store.close();}
