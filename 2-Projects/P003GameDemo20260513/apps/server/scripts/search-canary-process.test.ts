import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createServer} from 'node:net';
import {SignJWT} from 'jose';import {DatabaseSync} from 'node:sqlite';
const root=mkdtempSync(join(tmpdir(),'canary-process-'));const sentinel=join(root,'sentinel');writeFileSync(sentinel,'production sentinel');const before=statSync(sentinel).mtimeMs;
const canary=join(root,'candidate');(await import('node:fs')).mkdirSync(canary);
const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as any).port;await new Promise<void>(r=>listener.close(()=>r()));
const app=resolve('src/search-canary-main.ts'),loader=resolve('node_modules/tsx/dist/loader.mjs');let log='';
const child=spawn(process.execPath,['--experimental-sqlite','--import',loader,app],{cwd:canary,env:{PATH:process.env.PATH,SEARCH_CANARY_ROOT:canary,SEARCH_CANARY_SN:'BJP00326070803800006',SEARCH_WORKER_ACCOUNT_ID:'search-canary-worker',CUSTOM_LLM_API_KEY:'test-key',AUTH_JWT_SECRET:'synthetic-secret',SEARCH_CANARY_GENERATION:'test',SEARCH_CANARY_HEALTH_FILE:join(canary,'health.json'),PORT:String(port),SEARCH_ENABLED:'1',DEEPSEEK_API_KEY:'synthetic',SEARCH_ALLOWED_DOMAINS:'weather.com.cn'}});
child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
const base='http://127.0.0.1:'+port;
try {
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}if(child.exitCode!==null)throw new Error('child exited '+log);await new Promise(r=>setTimeout(r,100));}assert.ok(ready,log);
 const db=new DatabaseSync(join(canary,'data/config.db'));const flag=(key:string,value:string)=>db.prepare('INSERT OR REPLACE INTO runtime_flag (key,value,updated_at,updated_by,note) VALUES (?,?,0,?,?)').run(key,value,'test','test');
 const token=await new SignJWT({role:'device',accountId:'search-canary-worker'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('1h').sign(new TextEncoder().encode('synthetic-secret'));
 const hb={method:'POST',headers:{authorization:'Bearer test-key','x-p003-worker-token':token,'content-type':'application/json'},body:JSON.stringify({agent:'p003-search-canary-20261021',generation:'test',registered:true,jobs:0,ordered_pcm_v1:true})};
 assert.equal((await fetch(base+'/v1/internal/canary-health',hb)).status,200);
 assert.ok(JSON.parse(readFileSync(join(canary,'health.json'),'utf8')).until_ms>Date.now());
 for(const delta of [{jobs:1},{registered:false}]) {
  const body=JSON.stringify({...JSON.parse(hb.body),...delta});
  assert.equal((await fetch(base+'/v1/internal/canary-health',{...hb,body})).status,200);
  assert.equal(JSON.parse(readFileSync(join(canary,'health.json'),'utf8')).until_ms,0);
 }
 assert.equal((await fetch(base+'/v1/internal/canary-health',{...hb,body:JSON.stringify({...JSON.parse(hb.body),generation:'wrong'})})).status,400);
 const room='sn-BJP00326070803800006-123'; const url='/v1/internal/local-audio-texts?room='+room+'&token='+token;
 assert.equal((await fetch(base+url)).status,401);
 const headers={authorization:'Bearer test-key'};
 assert.equal((await fetch(base+url,{headers})).status,403);
 flag('p003.search.canary.expires_at_ms',String(Date.now()+10000));
 // Auth passed to route; unseeded device is denied, proving no production identity fallback.
 assert.equal((await fetch(base+url,{headers})).status,401);
 assert.equal((await fetch(base+'/v1/internal/search-tasks?room='+room,{headers:{...headers,'x-p003-worker-token':token}})).status,401);
 assert.equal((await fetch(base+'/v1/admin?room='+room+'&token='+token,{headers})).status,403);
 flag('p003.search.canary.expires_at_ms',String(Date.now()-1));
 assert.equal((await fetch(base+url,{headers})).status,403);
 db.close();assert.equal(statSync(sentinel).mtimeMs,before);assert.equal(readFileSync(sentinel,'utf8'),'production sentinel');
 console.log('canary process: boot, isolated stores, auth, expiry, sentinel passed');
}finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(r=>child.once('exit',()=>r()));}rmSync(root,{recursive:true,force:true});}
