import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {serve} from '@hono/node-server';
import {ArkStore} from '../src/ark/store.js';
const module=await import('../src/ark/archive-control.js').catch(()=>null);
assert.ok(module,'same-owner archive control route is required');
const token='d'.repeat(64);
function run(args:string[],env:NodeJS.ProcessEnv){return new Promise<{code:number|null;out:string;err:string}>(resolve=>{const p=spawn('python3',args,{env});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('close',code=>resolve({code,out,err}));});}
test('real Python export uses read-only DB and owner HTTP; authenticated ACK drains once with device snapshots concurrent',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ark-control-'))),path=join(root,'ark.db'),spool=join(root,'spool'),now=Date.now();
 const store=new ArkStore(path,undefined,()=>({enabled:true,limitBytes:1e9,reserveBytes:0,freeBytes:1e12}));
 const id={sn:'BJP00399999999999901',account_id:'test',epoch:1};store.authorize(id,now);
 const base=JSON.parse(readFileSync('../../docs/ark-brain-20261031/snapshot-v1.example.json','utf8'));let n=0,enabled=true;
 const accept=()=>{n++;return store.tryAccept(id,{...base,snapshot_id:'s'+n,sequence:n,boot_id:'b',boot_started_at_ms:now-1,captured_at_ms:now+n,wallets:{family_coin:n,stardust:null}},now+n);};for(let i=0;i<5;i++)accept();
 const app=module.createArkArchiveControl({store:()=>store,secret:()=>token,enabled:()=>enabled});const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');const url='http://127.0.0.1:'+(server.address() as any).port;
 const env={...process.env,ARK_ARCHIVE_CONTROL_URL:url,ARK_ARCHIVE_CONTROL_SECRET:token};
 let timer:ReturnType<typeof setInterval>|undefined,failures:unknown[]=[];
 try{
  const q={op:'claim',archive_id:'f'.repeat(32),now};
  const post=(body:unknown,auth=token)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Ark-Archive-Token':auth},body:JSON.stringify({database:path,command:body})});
  assert.equal((await post(q,'wrong')).status,401);enabled=false;assert.equal((await post(q)).status,404);enabled=true;
  assert.equal((await post({op:'sql',sql:'DELETE FROM ark_current'})).status,400);
  const wrongDb=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Ark-Archive-Token':token},body:JSON.stringify({database:path+'.other',command:q})});assert.equal(wrongDb.status,409);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ark_archive_batch').get()!.n,0);
  timer=setInterval(()=>{if(n<80)try{accept();}catch(e){failures.push(e);}},5);
  const first=await run(['scripts/storage-ark-export.py','--require-owner','--db',path,'--root',spool],env);assert.equal(first.code,0,first.err);assert.equal(JSON.parse(first.out).writer_mode,'brain-owner');clearInterval(timer);
  assert.deepEqual(failures,[]);const current=store.current(id)!.snapshot.wallets.family_coin;assert.equal(current,n);
  // Recover the remainder after concurrent appends. ACKs are synthetic local transport
  // receipts, not a claim of a live NAS round trip.
  for(let i=0;i<10&&Number(store.db.prepare('SELECT pending_records FROM ark_archive_stats').get()!.pending_records)>0;i++){
   const exp=await run(['scripts/storage-ark-export.py','--require-owner','--db',path,'--root',spool],env);assert.equal(exp.code,0,exp.err);
   const code="import importlib.util,sys;from pathlib import Path;s=importlib.util.spec_from_file_location('a',Path('scripts/storage-archive.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);sp=m.Spool(Path(sys.argv[1]));[(sp.ack(x['archive_id'],x['sha256'],x['bytes'],x['record_count'])) for x in sp.list()]";
   assert.equal((await run(['-c',code,spool],env)).code,0);
  }
  assert.equal(store.db.prepare('SELECT pending_records FROM ark_archive_stats').get()!.pending_records,0);
  assert.equal(store.current(id)!.snapshot.wallets.family_coin,n);
  // A configured unavailable owner must fail closed, never silently resume direct writes.
  const before=store.db.prepare('SELECT last_success_ms FROM ark_archive_stats').get()!.last_success_ms;
  const missing=await run(['scripts/storage-ark-export.py','--require-owner','--db',path,'--root',spool],{...env,ARK_ARCHIVE_CONTROL_URL:''});assert.equal(missing.code,1);assert.match(missing.err,/archive_control_required/);assert.equal(store.db.prepare('SELECT last_success_ms FROM ark_archive_stats').get()!.last_success_ms,before);
  const failed=await run(['scripts/storage-ark-export.py','--require-owner','--db',path,'--root',spool],{...env,ARK_ARCHIVE_CONTROL_SECRET:'wrong'});assert.notEqual(failed.code,0);assert.equal(store.db.prepare('SELECT last_success_ms FROM ark_archive_stats').get()!.last_success_ms,before);
 }finally{clearInterval(timer);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});
