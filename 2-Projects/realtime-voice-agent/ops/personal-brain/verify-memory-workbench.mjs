// Exercise the authenticated owner routes in an isolated released bundle, without sending data to any provider.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {Server} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

const dir=mkdtempSync(join(tmpdir(),'memory-workbench-'));
const owner='isolated-owner',key=randomBytes(32).toString('hex'), worker=randomBytes(32).toString('hex');
const keyfile=join(dir,'management.key');
writeFileSync(keyfile,key,{mode:0o600});
Object.assign(process.env,{BRAIN_DATA_DIR:dir,BRAIN_OWNER_ID:owner,BRAIN_WORKER_KEY:worker,
  BRAIN_CONSOLE_KEY_FILE:keyfile,BRAIN_UPSTREAM_BASE_URL:'https://model.invalid/v1',BRAIN_UPSTREAM_API_KEY:'fixture',BRAIN_UPSTREAM_MODEL:'fixture'});
const oldListen=Server.prototype.listen,request=globalThis.fetch;
let server,db,chats;
Server.prototype.listen=function(_port,...args){server=this;return oldListen.call(this,0,'127.0.0.1',...args.slice(1));};
globalThis.fetch=()=>{throw Error('unexpected provider request');};
try {
  await import(pathToFileURL(resolve(process.argv[2])).href);
  while(!server?.listening)await delay(5);
  const base='http://127.0.0.1:'+server.address().port;
  async function call(path,method='GET',body,status=200) {
    const r=await request(base+'/internal/console'+path,{method,headers:{authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
    const data=await r.json();assert.equal(r.status,status,path+' '+JSON.stringify(data));return data;
  }
  db=new DatabaseSync(join(dir,'profile.sqlite'));chats=new DatabaseSync(join(dir,'conversations.sqlite'));
  const addTurn=(id,account,role,text,at)=>chats.prepare('INSERT INTO conversation(id,session_id,account_id,role,text,ts) VALUES(?,?,?,?,?,?)').run(id,'test-room',account,role,text,at);
  const addItem=(id,type,content,source,at)=>db.prepare("INSERT INTO memory_item(id,type,account_id,content,source_msg_id,created_at) VALUES(?,?,?,?,?,?)").run(id,type,owner,content,source,at);
  await call('/memories','POST',{kind:'preference',topic:'红茶',value:'喜欢'});
  const old=(await call('/memories?state=verified&q='+encodeURIComponent('红茶'))).items[0];
  assert(old?.id && old.editable && old.state==='verified');
  const time=old.updatedAt+1000;
  addTurn('one',owner,'user','我不喜欢红茶。',time);
  addItem('cand','preference','不喜欢红茶','one',time);
  addTurn('temp',owner,'user','我今天不喜欢红茶。',time+1);
  addItem('scoped','preference','不喜欢冰红茶','temp',time+1);
  addTurn('blocked','other','user','仅另一个账号可见的文字',time+2);
  addTurn('orphan',owner,'assistant','旧的回复',time+3);
  const conflicts=await call('/memories?state=conflict'), candidate=conflicts.items[0];
  assert.equal(conflicts.counts.conflicts,1);assert.equal(candidate.conflict.id,old.id);assert.equal(candidate.proposed.value,'不喜欢');
  assert.equal((await call('/memories/'+candidate.id)).sourceTurn.id,'one');
  const anchor=await call('/conversations/test-room?anchor=orphan&limit=1');
  assert.equal(anchor.items[0].id,'orphan'); assert.equal(anchor.offset,2);
  await call('/conversations/test-room?anchor=blocked&limit=1','GET',undefined,404);
  assert.equal((await call('/turns/orphan/memories')).state,'unknown');
  const pre=await call('/memory-preview','POST',{text:'聊聊红茶'});assert.deepEqual(pre.items.map(x=>x.id),[old.id]);
  assert.equal((await call('/memories/'+old.id)).item.usageCount,0);
  db.prepare('INSERT INTO personal_turn_recall(account_id,reply_msg_id,mode,memory_ids,source_ids) VALUES(?,?,?,?,?)').run(owner,'orphan','model',JSON.stringify([old.id]),'[]');
  assert.equal((await call('/memories/'+old.id)).uses[0].id,'orphan');
  assert.equal((await call('/turns/orphan/memories')).items[0].value,'喜欢');
  const approve={...candidate.proposed,expected:candidate.value,action:'approve'};
  await call('/memories/'+candidate.id+'/review','POST',approve,409);
  await call('/memories/'+candidate.id+'/review','POST',{...approve,expectedPeer:old.id});
  const latest=(await call('/memories?state=verified&q='+encodeURIComponent('红茶'))).items.find(x=>x.topic==='红茶');
  assert.equal(latest.value,'不喜欢');
  assert.equal((await call('/memories/'+latest.id)).sourceTurn.session,'owner-console');
  assert.equal((await call('/turns/orphan/memories')).items[0].id,null);
  assert.equal((await call('/memories?state=conflict')).total,0);
  const pending=(await call('/memories?state=pending')).items.find(x=>x.value==='不喜欢冰红茶');
  await call('/memories/'+pending.id+'/review','POST',{action:'ignore',expected:pending.value});
  assert((await call('/memories?state=inactive')).items.some(x=>x.id===pending.id));
  addTurn('promise',owner,'assistant','明天陪你复习。',time+4);
  addItem('promise-item','promise','明天陪你复习','promise',time+4);
  db.prepare("UPDATE memory_item SET subject='xiaoke' WHERE id='promise-item'").run();
  const promise=(await call('/memories?kind=assistant-promise')).items[0];assert(promise?.canResolve);
  await call('/memories/'+promise.id+'/review','POST',{action:'resolve',expected:promise.value});
  assert((await call('/memories?state=inactive')).items.some(x=>x.disposition==='resolved'));
  const log=db.prepare('INSERT INTO extraction_log(id,account_id,ts,ok,candidates,added,rejected,source_msg_id) VALUES(?,?,?,?,?,?,?,?)');
  log.run(randomUUID(),owner,time,0,1,0,'未能验证原话','one');
  log.run(randomUUID(),'other',time,0,9,0,'其他账号','blocked');
  const ex=await call('/extractions');assert.deepEqual(ex.summary,{runs:1,failed:1,candidates:1,added:0});
  assert.equal(ex.items[0].sourceTurn.text,'我不喜欢红茶。');
  assert.deepEqual(ex.service,{configured:true,provider:'personal',pending:0,lastAt:time,lastOk:false,lastFailure:{at:time,reason:'未能验证原话'}});
  const growth=await call('/growth/snapshots');assert.equal(growth.items.length,1);assert.equal(growth.dimensions.length,5);assert(growth.items[0].traits.storytelling>=0);
  console.log('PASS archived/pending/verified filters, scoped conflict resolution, provenance, preview vs actual use, extraction isolation, daily trait snapshots');
} finally {
  Server.prototype.listen=oldListen;globalThis.fetch=request;db?.close();chats?.close();
  server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());rmSync(dir,{recursive:true,force:true});
}
