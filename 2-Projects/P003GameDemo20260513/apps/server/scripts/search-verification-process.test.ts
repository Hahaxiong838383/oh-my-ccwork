import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {SignJWT} from 'jose';
import {DatabaseSync} from 'node:sqlite';
const root=realpathSync(mkdtempSync(join(tmpdir(),'verification-process-')));
const agent='p003-search-verification-20261026',sn='BJP00399999999999901';
const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
let log='';const child=spawn(process.execPath,['--experimental-sqlite','--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('src/search-canary-main.ts')],{
 cwd:root,env:{PATH:process.env.PATH,SEARCH_CANARY_ROOT:root,SEARCH_CANARY_AGENT:agent,SEARCH_CANARY_SN:sn,
 SEARCH_CANARY_MAX_JOBS:'1',SEARCH_WORKER_ACCOUNT_ID:'search-canary-worker',CUSTOM_LLM_API_KEY:'test-key',AUTH_JWT_SECRET:'synthetic-secret',
 SEARCH_CANARY_GENERATION:'verify-test',SEARCH_REQUIRE_CLEANUP_HEALTH:'1',SEARCH_CANARY_HEALTH_FILE:join(root,'health.json'),
 SEARCH_RESUME_V1:'1',SEARCH_RESUME_AUTHORITY_DB_PATH:join(root,'data/devices.db'),PORT:String(port),
 SEARCH_ENABLED:'1',DEEPSEEK_API_KEY:'synthetic',SEARCH_ALLOWED_DOMAINS:'weather.com.cn'}});
child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
const base='http://127.0.0.1:'+port;
try {
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}
  if(child.exitCode!==null)throw new Error('child exited '+log);await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,log);assert.equal((await (await fetch(base+'/health')).json()).agent,agent);
 const token=await new SignJWT({role:'device',accountId:'search-canary-worker'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('1h').sign(new TextEncoder().encode('synthetic-secret'));
 const headers={authorization:'Bearer test-key','x-p003-worker-token':token,'content-type':'application/json'};
 const payload={agent,generation:'verify-test',registered:true,jobs:0,ordered_pcm_v1:true,cleanup:{healthy:true,at_ms:Date.now(),pending:0,remaining:0}};
 const health=async(delta:object)=>fetch(base+'/v1/internal/canary-health',{method:'POST',headers,body:JSON.stringify({...payload,...delta})});
 assert.equal((await health({agent:'p003-search-canary-20261021'})).status,400);
 assert.equal((await health({})).status,200);assert.ok(JSON.parse(readFileSync(join(root,'health.json'),'utf8')).until_ms>Date.now());
 assert.equal((await health({jobs:1})).status,200);assert.equal(JSON.parse(readFileSync(join(root,'health.json'),'utf8')).until_ms,0);
 const db=new DatabaseSync(join(root,'data/config.db'));
 const expiry=(at:number)=>db.prepare('INSERT OR REPLACE INTO runtime_flag (key,value,updated_at,updated_by,note) VALUES (?,?,0,?,?)').run('p003.search.canary.expires_at_ms',String(at),'test','test');
 expiry(Date.now()+60000);
 for(const real of ['BJP00326060100100004','BJP00326070803800006']) {
  assert.equal((await fetch(base+'/v1/internal/search-tasks?room=sn-'+real+'-123',{headers})).status,403);
 }
 const url=base+'/v1/internal/search-tasks?room=sn-'+sn+'-123';
 assert.equal((await fetch(url,{headers:{...headers,authorization:'Bearer wrong'}})).status,401);
 assert.equal((await fetch(url,{headers})).status,401,'synthetic identity must still be registered; no production fallback');
 expiry(Date.now()-1);assert.equal((await fetch(url,{headers})).status,403);db.close();
 console.log('verification process: own agent, health lease, auth, real-device rejection and expiry passed');
}finally{
 if(child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(r=>child.once('exit',()=>r()));}
 rmSync(root,{recursive:true,force:true});
}
