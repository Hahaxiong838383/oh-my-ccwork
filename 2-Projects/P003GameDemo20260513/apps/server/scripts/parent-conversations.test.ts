/** Synthetic loopback HTTP and temporary SQLite only; no production records or credentials. */
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const root=mkdtempSync(join(tmpdir(),'parent-conversations-')); process.chdir(root);
for(const key of ['TELEMETRY','DEVICES','ACCOUNTS','PROFILE','ARK','CONFIG','PAIRING','BLE_BINDINGS','CONVERSATION'])process.env[`${key}_DB_PATH`]=join(root,`${key}.db`);
process.env.AUTH_JWT_SECRET='synthetic-parent-history-test';
process.env.ARK_CONTEXT_SN_ALLOW=''; process.env.ARK_RECORDS_SN_ALLOW=''; delete process.env.PARENT_CONVERSATION_SCOPE_JSON;
const {Hono}=await import('hono'); const {serve}=await import('@hono/node-server'); const {SignJWT}=await import('jose');
const {parentTelemetryRoute}=await import('../src/routes/telemetry.js');
const {deviceRegistryStore:registry}=await import('../src/device-registry-store.js');
const {accountStore}=await import('../src/account-store.js');
const {conversationStore}=await import('../src/conversation-store.js');
const app=new Hono(); app.route('/v1/parent/devices',parentTelemetryRoute);
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0}); await new Promise<void>(r=>server.listening?r():server.once('listening',r));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
const devices=new DatabaseSync(process.env.DEVICES_DB_PATH!),accounts=new DatabaseSync(process.env.ACCOUNTS_DB_PATH!),conversations=new DatabaseSync(process.env.CONVERSATION_DB_PATH!);
after(async()=>{devices.close();accounts.close();conversations.close();await new Promise<void>(r=>server.close(()=>r()));});
let serial=0;
async function token(accountId:string,role='parent'){return new SignJWT({accountId,role}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));}
async function fixture(){
 const n=++serial,sn=`BJP003260601${String(n).padStart(8,'0')}`,owner=`history-parent-${n}`;
 accounts.prepare("INSERT INTO account(id,nickname,role,created_at) VALUES(?,'synthetic','parent',?)").run(owner,Date.now());
 registry.add(sn,'synthetic');registry.setParentAccountId(sn,owner);const account=accountStore.createDeviceAccount(sn,'synthetic').id;registry.setAccountId(sn,account);
 const d=registry.get(sn)!,epoch=registry.arkIdentity(sn)!.epoch;
 const scope={public_id:d.public_id!,sn,parent_account_id:owner,account_id:account,binding_version:d.binding_version,epoch};
 process.env.PARENT_CONVERSATION_SCOPE_JSON=JSON.stringify(scope);
 return {sn,owner,account,pub:d.public_id!,scope,token:await token(owner)};
}
type F=Awaited<ReturnType<typeof fixture>>;
function add(f:F,id:string,ts:number,role='user',text='synthetic text'){
 conversations.prepare('INSERT INTO conversation(id,account_id,session_id,role,text,ts,tokens,memory_excluded) VALUES(?,?,\'rtc\',?,?,?,0,0)').run(id,f.account,role,text,ts);
}
async function request(f:F,path:string,bearer=f.token){const r=await fetch(base+`/v1/parent/devices/${f.pub}/`+path,{headers:bearer?{authorization:`Bearer ${bearer}`}:{}});const text=await r.text();let body:any;try{body=JSON.parse(text);}catch{body={raw:text};}return {status:r.status,headers:r.headers,body};}
const page=(f:F,q='',bearer=f.token)=>request(f,'conversations'+q,bearer);
const dash=async(f:F,bearer=f.token)=>{const r=await request(f,'dashboard',bearer);if(r.status===200)assert.ok(r.body.data.conversations,'dashboard conversation summary missing');return r;};
const data=async(f:F,q='')=>{const r=await page(f,q);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers.get('cache-control'),'no-store');return r.body.data;};

// Missing feature: a family must be able to page all explicitly authorized historical messages.
test('184 historical messages page once each with exact user/assistant counts and no authority metadata',async()=>{
 const f=await fixture(),start=Date.parse('2026-11-14T16:00:00Z');
 for(let n=0;n<184;n++)add(f,`history-${n.toString().padStart(3,'0')}`,start+Math.floor(n/2)*1000,n%2?'assistant':'user',`text-${n}`);
 let p=await data(f),ids:string[]=[],pages=0;
 do {
  assert.equal(p.schema_version,1);assert.equal(p.message_count,184);assert.equal(p.user_message_count,92);assert.equal(p.assistant_message_count,92);
  assert.equal(p.first_message_at_ms,start);assert.equal(p.last_message_at_ms,start+91000);assert.equal(p.history_complete,false);
  for(const item of p.items)assert.deepEqual(Object.keys(item).sort(),['id','role','text','ts']);
  assert.ok(!JSON.stringify(p).includes(f.sn));assert.ok(!JSON.stringify(p).includes(f.owner));
  ids.push(...p.items.map((x:any)=>x.id));pages++;
  if(!p.has_more){assert.equal(p.next_cursor,null);break;}
  p=await data(f,'?cursor='+encodeURIComponent(p.next_cursor));
 }while(pages<20);
 assert.equal(pages,10);assert.equal(ids.length,184);assert.equal(new Set(ids).size,184);assert.equal(ids[0],'history-183');assert.equal(ids.at(-1),'history-000');
 const d=await dash(f);assert.equal(d.status,200);const summary=d.body.data.conversations;
 assert.equal(summary.available,true);assert.equal(summary.reason,null);assert.equal(summary.message_count,184);assert.equal(summary.user_message_count,92);
 assert.equal(summary.assistant_message_count,92);assert.equal(summary.history_complete,false);assert.equal(summary.source,'conversation');assert.equal('items' in summary,false);assert.equal(JSON.stringify(summary).includes('text-'),false);
});

// Catches a later or backdated insertion appearing inside a pinned page/summary.
test('new messages only enter a fresh first page; same timestamps have stable id ordering',async()=>{
 const f=await fixture();for(let n=0;n<25;n++)add(f,`stable-${n.toString().padStart(2,'0')}`,1000);
 const first=await data(f);add(f,'new-latest',2000);add(f,'new-backdated',500);
 const second=await data(f,'?cursor='+first.next_cursor);
 assert.equal(second.message_count,25);assert.equal(second.items.length,5);assert.deepEqual(second.items.map((x:any)=>x.id),['stable-04','stable-03','stable-02','stable-01','stable-00']);
 assert.equal((await data(f)).message_count,27);assert.equal((await data(f)).items[0].id,'new-latest');
});

// Catches applying UTC days, invalid dates, duplicate query keys, and an unbounded limit.
test('Shanghai day filters include exact boundaries and validate query shapes',async()=>{
 const f=await fixture(),start=Date.parse('2026-11-14T16:00:00Z');
 add(f,'before',start-1);add(f,'start',start);add(f,'end',start+86400000-1,'assistant');add(f,'after',start+86400000);
 const d=await data(f,'?from_day=2026-11-15&to_day=2026-11-15&limit=50');
 assert.deepEqual(d.items.map((x:any)=>x.id),['end','start']);assert.equal(d.message_count,2);
 for(const q of ['?limit=0','?limit=51','?limit=1&limit=2','?from_day=2026-02-30','?from_day=2026-11-16&to_day=2026-11-15','?account_id=anything'])assert.equal((await page(f,q)).status,400,q);
 const empty=await data(f,'?from_day=2030-01-01');assert.equal(empty.message_count,0);assert.equal(empty.first_message_at_ms,null);assert.deepEqual(empty.items,[]);
});

// Catches cursor forgery, cross-filter reuse, and silently restarting expired cursors.
test('opaque cursor rejects tampering, altered filters, expiration, and deleted high-water anchor',async()=>{
 const f=await fixture();for(let n=0;n<25;n++)add(f,`cursor-${n}`,1000+n);
 const first=await data(f),cursor=first.next_cursor;
 const altered=cursor.slice(0,Math.floor(cursor.length/2))+(cursor[Math.floor(cursor.length/2)]==='A'?'B':'A')+cursor.slice(Math.floor(cursor.length/2)+1);
 assert.equal((await page(f,'?cursor='+altered)).status,400);
 assert.equal((await page(f,'?cursor='+cursor+'&limit=21')).status,400);
 assert.equal((await page(f,'?cursor='+cursor+'&from_day=2000-01-01')).status,400);
 const realNow=Date.now;Date.now=()=>realNow()+1800001;
 try{assert.equal((await page(f,'?cursor='+cursor)).status,410);}finally{Date.now=realNow;}
 conversations.prepare('DELETE FROM conversation WHERE id=?').run('cursor-24');add(f,'replacement',1024);
 assert.equal((await page(f,'?cursor='+cursor)).status,410);
});

// Catches treating any signed token as a parent, or exposing existence through a copied cursor.
test('parent JWT and account role required; other parent and unknown device stay 404 with no-store',async()=>{
 const f=await fixture();add(f,'private',1000);
 for(const bearer of ['', 'forged',await token(f.owner,'device'),await token(f.account,'parent')]){
  const r=await page(f,'',bearer);assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');
 }
 const other='other-parent';accounts.prepare("INSERT INTO account(id,nickname,role,created_at) VALUES(?,'other','parent',1)").run(other);
 const r=await page(f,'?cursor=bogus',await token(other));assert.equal(r.status,404);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.equal((await page({...f,pub:'dev_0000000000000000'})).status,404);
});

// Catches exposing history by default or silently accepting misspelled authorization configuration.
test('scope is explicit and strict; empty disables, malformed fails closed, counts are null when disabled',async()=>{
 const f=await fixture();add(f,'closed',1000);delete process.env.PARENT_CONVERSATION_SCOPE_JSON;
 assert.equal((await page(f)).status,404);let d=(await dash(f)).body.data.conversations;
 assert.equal(d.available,false);assert.equal(d.reason,'not_enabled');assert.equal(d.message_count,null);
 for(const raw of ['{',JSON.stringify({...f.scope,extra:true}),JSON.stringify({...f.scope,epoch:0}),JSON.stringify([f.scope])]){
  process.env.PARENT_CONVERSATION_SCOPE_JSON=raw;assert.equal((await page(f)).status,503);
  d=(await dash(f)).body.data.conversations;assert.equal(d.reason,'dependency_unavailable');assert.equal(d.message_count,null);
 }
});

// Catches inheriting old conversations on rebind and re-enabling them by switching back.
test('rebind and switch-back cannot reuse the originally authorized scope or cursor',async()=>{
 const f=await fixture();for(let n=0;n<25;n++)add(f,`owner-${n}`,1000+n);const first=await data(f);
 registry.setParentAccountId(f.sn,'next-owner');assert.equal((await page(f,'?cursor='+first.next_cursor)).status,404);
 registry.setParentAccountId(f.sn,f.owner);assert.equal((await page(f)).status,404);
 assert.equal((await dash(f)).body.data.conversations.reason,'not_enabled');
});

// Catches authority changes that do not alter the parent UUID.
test('brain, epoch, status, binding version and shared brain account each fail closed',async()=>{
 for(const mutation of ['brain','epoch','status','binding','shared']){
  const f=await fixture();add(f,'authority-'+mutation,1000);
  if(mutation==='brain')registry.setAccountId(f.sn,accountStore.createDeviceAccount(`BJP003260602${String(++serial).padStart(8,'0')}`,'other').id);
  if(mutation==='epoch')devices.prepare('UPDATE ark_device_epoch SET epoch=epoch+1 WHERE sn=?').run(f.sn);
  if(mutation==='status')registry.setStatus(f.sn,'disabled');
  if(mutation==='binding')devices.prepare('UPDATE device_registry SET binding_version=binding_version+1 WHERE sn=?').run(f.sn);
  if(mutation==='shared'){const sibling=`BJP003260603${String(++serial).padStart(8,'0')}`;registry.add(sibling,'synthetic');registry.setAccountId(sibling,f.account);}
  assert.equal((await page(f)).status,404,mutation);assert.equal((await dash(f)).body.data.conversations.reason,'not_enabled',mutation);
 }
});

// Catches leaking another device's messages or accepting another authorized scope's cursor.
test('query and cursor stay scoped to the device brain account',async()=>{
 const a=await fixture();for(let n=0;n<25;n++)add(a,`a-${n}`,1000+n);const first=await data(a);
 const b=await fixture();add(b,'b-only',3000);const d=await data(b);assert.deepEqual(d.items.map((x:any)=>x.id),['b-only']);
 assert.equal((await page(b,'?cursor='+first.next_cursor)).status,400);
});

// Catches a new dependency failure breaking old dashboard modules or accidentally creating a DB.
test('conversation SQL failure only degrades its dashboard domain; missing read DB is not created',async()=>{
 const f=await fixture();add(f,'failure',1000);const baseline=await dash(f);assert.equal(baseline.status,200);
 conversations.exec('ALTER TABLE conversation RENAME TO conversation_unavailable');
 try{
  assert.equal((await page(f)).status,503);const r=await dash(f);assert.equal(r.status,200);
  for(const key of ['ark','records','usage','device','today','week','availability'])assert.deepEqual(r.body.data[key],baseline.body.data[key],key);
  assert.equal(r.body.data.conversations.reason,'dependency_unavailable');assert.equal(r.body.data.conversations.message_count,null);
 }finally{conversations.exec('ALTER TABLE conversation_unavailable RENAME TO conversation');}
 const original=process.env.CONVERSATION_DB_PATH;const missing=join(root,'missing.db');process.env.CONVERSATION_DB_PATH=missing;
 try{assert.equal((await page(f)).status,503);assert.equal(existsSync(missing),false);}finally{process.env.CONVERSATION_DB_PATH=original;}
 assert.equal((await data(f)).message_count,1);
});

// Catches modifying original history while exposing it to parents.
test('all history reads preserve original message contents and rows',async()=>{
 const f=await fixture();const msg=conversationStore.add({account_id:f.account,session_id:'rtc',role:'user',text:'history original'});
 const before=conversations.prepare('SELECT * FROM conversation WHERE id=?').get(msg.id);
 await data(f);await dash(f);
 assert.deepEqual(conversations.prepare('SELECT * FROM conversation WHERE id=?').get(msg.id),before);
});

// Catches opening the optional history database before checking that this domain is enabled.
test('disabled scope remains not_enabled even when the conversation DB is absent',async()=>{
 const f=await fixture(),original=process.env.CONVERSATION_DB_PATH,missing=join(root,'disabled-missing.db');
 delete process.env.PARENT_CONVERSATION_SCOPE_JSON;process.env.CONVERSATION_DB_PATH=missing;
 try{const r=await dash(f);assert.equal(r.status,200);assert.equal(r.body.data.conversations.reason,'not_enabled');assert.equal(existsSync(missing),false);}
 finally{process.env.CONVERSATION_DB_PATH=original;}
});

// Catches an accounts dependency exception escaping the new domain and breaking old dashboard data.
test('account lookup failure degrades only conversations and keeps existing dashboard fields',async()=>{
 const f=await fixture(),baseline=await dash(f);accounts.exec('ALTER TABLE account RENAME TO account_unavailable');
 try{
  const r=await dash(f);assert.equal(r.status,200);assert.equal(r.body.data.conversations.reason,'dependency_unavailable');
  for(const key of ['ark','records','usage','device','today','week','availability'])assert.deepEqual(r.body.data[key],baseline.body.data[key]);
  assert.equal((await page(f)).status,503);
 }finally{accounts.exec('ALTER TABLE account_unavailable RENAME TO account');}
});

async function rebindDuringRead(f:F,read:()=>Promise<unknown>,switchBack=false){
 const original=DatabaseSync.prototype.prepare;let fired=false;
 DatabaseSync.prototype.prepare=function(sql:string){
  const statement=original.call(this,sql);
  if(sql.startsWith('SELECT rowid water,id anchor FROM conversation')){
   const get=statement.get.bind(statement);
   statement.get=(...args:any[])=>{
    if(!fired){
     fired=true;
     // Real independent WAL writers, after the reader established its old devices snapshot.
     registry.setParentAccountId(f.sn,'race-new-owner');add(f,`new-family-${f.pub}`,2000,'user','new-family-private');
     if(switchBack)registry.setParentAccountId(f.sn,f.owner);
    }
    return get(...args);
   };
  }
  return statement;
 };
 try{await read();assert.equal(fired,true,'race must actually occur');}finally{DatabaseSync.prototype.prepare=original;}
}

// Catches independent WAL snapshots admitting a new family's message after an old permission read.
test('race: page rechecks authority after a second connection rebinds during the read',async()=>{
 const f=await fixture();add(f,'race-page-old',1000);
 await rebindDuringRead(f,async()=>{const r=await page(f);assert.equal(r.status,404);assert.equal(JSON.stringify(r.body).includes('new-family-private'),false);});
});

// Catches ABA rebind passing a final owner-only check, or exposing changed-family summary counts.
test('race: dashboard summary rejects rebind-and-switch-back during the read',async()=>{
 const f=await fixture();add(f,'race-summary-old',1000);
 await rebindDuringRead(f,async()=>{const r=await dash(f);assert.equal(r.status,200);assert.equal(r.body.data.conversations.reason,'not_enabled');assert.equal(r.body.data.conversations.message_count,null);},true);
});
