import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {getOperations, getDeviceDiagnostics} from './operations.ts';

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'personal-ops-'));
  t.after(() => rmSync(dir, {force:true, recursive:true}));
  return dir;
}
async function listen(server, destination, t) {
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(destination, resolve);});
  t.after(() => new Promise(resolve => server.close(resolve)));
}

test('operations checks producer payloads, only exposes selected fields and rejects empty successes independently', async t => {
  const dir = directory(t);
  const publishedAt = '2026-11-20T00:00:00Z';
  const path = '/mobile/night/xiaoke-night-101.apk';
  const routes = {
    '/mobile/night/latest.json': {schema:1, channel:'night', versionCode:101, versionName:'V1.0.1', publishedAt,
      size:201, sha256:'a'.repeat(64), packageName:'cc.hahaxiong.xiaoke.night', apkUrl:path, url:'https://pa.hahaxiong.cc:8666'+path},
    '/health': {ok:true, provider:'personal-local-pilot', voice:'chosen', asr_model:'asr-v1', tts_model:'tts-v1', output_rate:24000, tts_native_rate:16000},
    '/brain': {ok:true, service:'personal-brain', build:'demo', providers:{state:'ready', revision:2, llm:{provider:'deepseek', model:'v1', profile:'one', extra:'private-marker'}}},
  };
  const server=createServer((req,res) => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(routes[req.url]));});
  await listen(server,{host:'127.0.0.1',port:0},t);
  const endpoint='http://127.0.0.1:'+server.address().port;
  const receipt=join(dir,'receipt.json');
  const env={TALK_SITE_ORIGIN:endpoint,SPEECH_ORIGIN:endpoint,BRAIN_HEALTH_URL:endpoint+'/brain',PERSONAL_BACKUP_RECEIPT:receipt};
  assert.equal((await getOperations(env)).backup.state,'unreported');
  writeFileSync(receipt,JSON.stringify({schema:1,scope:'personal-voice',verifiedAt:publishedAt,capturedAt:publishedAt,databaseCount:6,archiveBytes:201}));
  const result=await getOperations(env);
  assert.equal(result.ota.sha256,'a'.repeat(64));
  assert.equal(result.speech.voice,'chosen');
  assert.equal(result.brain.llmModel,'v1');
  assert.equal(result.brain.revision,2);
  assert.equal(result.backup.state,'verified');
  assert.ok(!JSON.stringify(result).includes('private-marker'));
  routes['/mobile/night/latest.json'].url='https://other.test/'+path;
  routes['/brain'].service='generic-probe';
  writeFileSync(receipt,'{}');
  const wrong=await getOperations(env);
  assert.deepEqual([wrong.ota.state,wrong.brain.state,wrong.backup.state,wrong.speech.state],['unavailable','unavailable','unavailable','ready']);
  routes['/health']={note:'x'.repeat(18000)};
  assert.equal((await getOperations(env)).speech.state,'unavailable');
});

test('technical reports include exactly the requested registered device, received window and permitted event types',async t=>{
  const dir=directory(t), socket=join(dir,'owner.sock'), file=join(dir,'events.sqlite');
  const server=createServer((req,res)=>{assert.equal(req.url,'/devices');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({devices:[{device:'test-a'},{device:'empty'}]}));});
  await listen(server,socket,t);
  const now=Math.floor(Date.now()/1000), db=new DatabaseSync(file);
  t.after(()=>db.close());
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE events (device TEXT,id TEXT,kind TEXT,ts INTEGER,received_at INTEGER,version_code INTEGER)');
  db.exec('CREATE TABLE ingest(batch_id TEXT PRIMARY KEY,device TEXT,events INTEGER,inserted INTEGER,repeats INTEGER,received_at INTEGER)');
  const add=db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)');
  for(let i=0;i<70;i++)add.run('test-a','a'+i,'connected',now-2,now-1,7);
  add.run('test-a','b','ota_check',now-90000,now-1,7);
  add.run('test-a','old','ota_check',now-90000,now-90000,6);
  add.run('removed','c','rx_caption',now,now,9);
  add.run('test-a','d','raw-text-not-permitted',now,now,7);
  const batch=db.prepare('INSERT INTO ingest VALUES(?,?,?,?,?,?)');
  batch.run('first','test-a',5,5,3,now-20);       // Original upload and two identical retries.
  batch.run('overlap','test-a',4,2,1,now-10);     // Two previously stored events in a new batch.
  batch.run('older','test-a',1,1,2,now-90000);
  batch.run('week-before','test-a',8,6,1,now-8*86400);
  batch.run('month-before','test-a',8,8,1,now-31*86400);
  batch.run('unrelated','removed',7,7,4,now-1);
  const lastAt=new Date((now-10)*1000).toISOString();
  const data=await getDeviceDiagnostics('test-a','1',file,socket);
  assert.equal(data.total,71);
  assert.equal(data.recent.length,60);
  assert.deepEqual(data.counts.map(v=>[v.kind,v.count]),[['connected',70],['ota_check',1]]);
  assert.ok(data.recent.every(v=>Object.keys(v).sort().join(',')==='at,kind,receivedAt,versionCode'));
  assert.deepEqual(data.uploads,{batches:4,submitted:19,inserted:7,repeats:12,lastAt});
  const week=await getDeviceDiagnostics('test-a','7',file,socket);
  assert.equal(week.total,72);
  assert.deepEqual(week.uploads,{batches:6,submitted:21,inserted:8,repeats:13,lastAt});
  const month=await getDeviceDiagnostics('test-a','30',file,socket);
  assert.deepEqual(month.uploads,{batches:7,submitted:29,inserted:14,repeats:15,lastAt});
  const empty=await getDeviceDiagnostics('empty','7',file,socket);
  assert.equal(empty.total,0);
  assert.deepEqual(empty.uploads,{batches:0,submitted:0,inserted:0,repeats:0,lastAt:null});
  await assert.rejects(getDeviceDiagnostics('removed','7',file,socket),{status:404});
  await assert.rejects(getDeviceDiagnostics('test-a','0',file,socket),{status:400});
  const missing=join(dir,'missing.sqlite');
  await assert.rejects(getDeviceDiagnostics('test-a','1',missing,socket),{status:503});
  assert.equal(existsSync(missing),false);
});
