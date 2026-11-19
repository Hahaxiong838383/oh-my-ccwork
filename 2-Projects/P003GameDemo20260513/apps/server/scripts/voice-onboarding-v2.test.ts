import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SignJWT} from 'jose';
import {serve} from '@hono/node-server';
import {VoiceOnboardingStore} from '../src/voice-onboarding-store.js';
import {createVoiceOnboardingRoute} from '../src/routes/voice-onboarding.js';
process.env.AUTH_JWT_SECRET='v2-synthetic-secret';
async function fixture(fn:(f:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'onboarding-v2-')),d=new DatabaseSync(join(dir,'devices.db')),p=new DatabaseSync(join(dir,'profile.db'));
 d.exec("CREATE TABLE device_registry(sn TEXT PRIMARY KEY,status TEXT,account_id TEXT,parent_account_id TEXT,public_id TEXT,binding_version INTEGER);INSERT INTO device_registry VALUES('synthetic','active','child','parent','public',1)");
 p.exec("CREATE TABLE family_member(id TEXT PRIMARY KEY,account_id TEXT,nickname TEXT,birthday TEXT,gender TEXT,updated_at INTEGER);INSERT INTO family_member VALUES('child','child','','','',1)");
 let now=100000;
 const store=new VoiceOnboardingStore(join(dir,'devices.db'),join(dir,'profile.db'),()=>now);
 const grant=store.issue({sn:'synthetic',session_id:'session',trace_id:'trace',room:'room',expires_at_ms:now+600000,version:2} as any);
 const token=await new SignJWT({role:'device',accountId:'worker-service'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
 const server=serve({fetch:createVoiceOnboardingRoute(()=>store).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await new Promise(r=>server.once('listening',r));
 const post=async(action:string,question_index:number,revision:number,extra:any={},auth=token)=>{
  const request_id=extra.request_id??`${action}-${question_index}-${revision}`;
  const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/v2/step`,{method:'POST',headers:{'content-type':'application/json','x-p003-worker-token':auth,'x-p003-onboarding-grant':grant.grant},body:JSON.stringify({v:2,session_id:'session',trace_id:'trace',lesson_id:'lesson',request_id,action,question_index,revision,...extra})});
  const raw=await r.text();let body:any;try{body=JSON.parse(raw);}catch{body={raw};}return {status:r.status,body};
 };
 const open=async(q:number,r:number)=>{assert.equal((await post('question_started',q,r)).status,200);assert.equal((await post('audio_complete',q,r+1)).status,200);};
 try{await fn({post,p,d,store,grant,open,now:(n:number)=>now=n});}finally{await new Promise<void>(r=>server.close(()=>r()));store.close();p.close();d.close();rmSync(dir,{recursive:true,force:true});}
}
test('v2 fixed questions, independent memory outcome, exact replay; no question/cue chosen by server',()=>fixture(async({post,p,grant,open}:any)=>{
 assert.equal(grant.version,2);
 const b=await post('begin',0,0);assert.equal(b.status,200);assert.equal(b.body.memory_write,'none');assert.equal(b.body.missing,undefined);
 await open(1,1);const a=await post('answer',1,2,{text:'八岁'});assert.equal(a.body.result,'accepted');assert.equal(a.body.memory_write,'saved');assert.equal(a.body.question_index,1);
 assert.deepEqual((await post('answer',1,2,{text:'八岁'})).body,a.body);assert.equal((await post('answer',1,2,{text:'九岁'})).status,409);
 await open(2,3);assert.equal((await post('answer',2,4,{text:'女孩'})).body.memory_write,'saved');
 await open(3,5);assert.equal((await post('answer',3,6,{text:'叫我小星'})).body.memory_write,'saved');
 const row=p.prepare('SELECT * FROM family_member').get();assert.equal(row.age_years,8);assert.equal(row.birthday,'');assert.equal(row.nickname,'小星');
 assert.equal((await post('finish',3,7)).body.result,'finished');assert.equal((await post('answer',3,6,{request_id:'late',text:'小月'})).status,410);
 assert.equal(JSON.stringify(a.body).includes('八岁'),false);assert.equal(a.body.audio_prompt,undefined);
}));
test('known profile never suppresses the three questions or overwrites existing fields',()=>fixture(async({post,p,open}:any)=>{
 p.exec("UPDATE family_member SET birthday='2018-08',gender='女孩',nickname='原名'");
 assert.equal((await post('begin',0,0)).status,200);
 for(const [q,text] of [[1,'九岁'],[2,'男孩'],[3,'小星']]){await open(q,q*2-1);const r=await post('answer',q,q*2,{text});assert.equal(r.body.result,'accepted');assert.equal(r.body.memory_write,'skipped');}
 assert.equal(p.prepare('SELECT nickname FROM family_member').get().nickname,'原名');
}));
test('all silent, declined and unrecognized progress only on client commands; old answer cannot save',()=>fixture(async({post,p,open}:any)=>{
 await post('begin',0,0);await open(1,1);assert.equal((await post('question_skipped',1,3)).status,200);
 assert.equal((await post('answer',1,2,{text:'八岁'})).status,409);
 await open(2,4);const declined=await post('answer',2,5,{text:'不告诉你'});assert.equal(declined.body.result,'declined');assert.equal(declined.body.memory_write,'skipped');
 await open(3,6);assert.equal((await post('answer',3,7,{text:'等一下'})).body.result,'unrecognized');
 assert.equal((await post('finish',3,8)).status,200);assert.equal(p.prepare('SELECT age_years FROM family_member').get().age_years,null);
}));
test('valid answer with actual SQLite write failure remains accepted/failed and next question works',()=>fixture(async({post,p,open}:any)=>{
 await post('begin',0,0);await open(1,1);p.exec("CREATE TRIGGER deny_age BEFORE UPDATE OF age_years ON family_member BEGIN SELECT RAISE(ABORT,'test'); END");
 const a=await post('answer',1,2,{text:'8岁'});assert.equal(a.status,200);assert.equal(a.body.result,'accepted');assert.equal(a.body.memory_write,'failed');
 assert.equal(p.prepare('SELECT age_years FROM family_member').get().age_years,null);await open(2,3);assert.equal((await post('answer',2,4,{text:'男孩'})).body.memory_write,'saved');
}));
test('playback, forged worker, old lesson/trace, revision, duplicate different request and simulation cannot save',()=>fixture(async({post,p}:any)=>{
 assert.equal((await post('begin',0,0,{},'bad')).status,403);
 assert.equal((await post('begin',0,0,{simulation:true})).status,400);
 await post('begin',0,0);await post('question_started',1,1);
 assert.equal((await post('answer',1,1,{text:'8岁'})).status,409);
 await post('audio_complete',1,2);
 assert.equal((await post('answer',1,2,{text:'8岁',trace_id:'old'})).status,403);
 assert.equal((await post('answer',1,2,{text:'8岁',lesson_id:'old'})).status,409);
 assert.equal((await post('answer',1,1,{text:'8岁'})).status,409);
 assert.equal((await post('answer',1,2,{text:'8岁'})).body.memory_write,'saved');
 assert.equal((await post('answer',1,2,{text:'9岁',request_id:'another'})).status,409);
 assert.equal(p.prepare('SELECT age_years FROM family_member').get().age_years,8);
}));
test('rebinding and 180s expiration refuse writes; cancel before begin fences late requests',()=>fixture(async({post,d,p,now}:any)=>{
 await post('begin',0,0);await post('question_started',1,1);await post('audio_complete',1,2);
 d.exec('UPDATE device_registry SET binding_version=2');assert.equal((await post('answer',1,2,{text:'8岁'})).status,409);
 now(280000);assert.equal((await post('question_skipped',1,3)).status,410);assert.equal(p.prepare('SELECT age_years FROM family_member').get().age_years,null);
}));
test('cancel before begin and finish at any question release server authority without a profile write',()=>fixture(async({post,p}:any)=>{
 assert.equal((await post('cancel',0,0)).status,200);assert.equal((await post('begin',0,0)).status,410);assert.equal(p.prepare('SELECT age_years FROM family_member').get().age_years,null);
}));
test('all three silent questions finish without inventing any profile fact',()=>fixture(async({post,p,open}:any)=>{
 await post('begin',0,0);
 for(let q=1;q<=3;q++){const r=(q-1)*3+1;await open(q,r);assert.equal((await post('question_skipped',q,r+2)).status,200);}
 assert.equal((await post('finish',3,10)).body.result,'finished');
 const row=p.prepare('SELECT nickname,gender,birthday,age_years FROM family_member').get();
 assert.deepEqual({...row},{nickname:'',gender:'',birthday:'',age_years:null});
}));
test('SQLite ignored update is not reported saved',()=>fixture(async({post,p,open}:any)=>{
 await post('begin',0,0);await open(1,1);
 p.exec("CREATE TRIGGER ignore_age BEFORE UPDATE OF age_years ON family_member BEGIN SELECT RAISE(IGNORE); END");
 const r=await post('answer',1,2,{text:'八岁'});assert.equal(r.body.result,'accepted');assert.equal(r.body.memory_write,'failed');
 assert.equal(p.prepare('SELECT age_years FROM family_member').get().age_years,null);
}));
