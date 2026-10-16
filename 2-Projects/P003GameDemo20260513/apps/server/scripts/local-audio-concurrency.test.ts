import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const dir=mkdtempSync(join(tmpdir(),'la-race-'));
process.env.PROFILE_DB_PATH=join(dir,'profile.db');process.env.LOCAL_AUDIO_DIR=join(dir,'audio');process.env.LOCAL_AUDIO_WRITES_PAUSED='0';
const {localAudioStore:store,REQUIRED_SLOTS,LOCAL_AUDIO_SLOTS,DEVICE_REPLY_SLOTS,G1_SETTINGS_SLOTS}=await import('../src/local-audio-store.js');
const {pcmToWav}=await import('../src/providers/xfyun-tts.js');
const {sha256}=await import('../src/local-audio-integrity.js');
const account='race-fixture',gen={tier:'test',traits:'{}'},audio=pcmToWav(Buffer.alloc(48000));
const stage=(slot:any,text:string,ms=1000)=>store.stageClipImmutable(account,{slot,text,audio:ms===1000?audio:pcmToWav(Buffer.alloc(ms*48)),durationMs:ms,format:'wav'});
const base=REQUIRED_SLOTS.flatMap(slot=>[0,1].map(n=>stage(slot,`测试${n}`))).map(i=>({slot:i.slot,id:i.id}));
store.commitSet(account,base,gen,{expectedRevision:0});
const addA=stage('device_reply.already','现在就是这样啦'),addB=stage('device_reply.failed','暂时没能确认调整结果');
const worker=join(dir,'race.mjs');
writeFileSync(worker,`import { localAudioStore as store } from ${JSON.stringify(pathToFileURL(resolve('src/local-audio-store.ts')).href)};
const data=JSON.parse(process.env.RACE_INPUT);process.stdout.write('ready\\n');
process.stdin.once('data',()=>{try{const revision=store.commitSet(data.account,data.keep,data.gen,{expectedRevision:1});console.log(JSON.stringify({revision}));}catch(e){console.log(JSON.stringify({code:e.code}));}process.stdin.destroy();});`);
function contestant(extra:any){
 const child=spawn(process.execPath,['--import','tsx',worker],{env:{...process.env,RACE_INPUT:JSON.stringify({account,keep:[...base,{slot:extra.slot,id:extra.id}],gen})},stdio:['pipe','pipe','pipe']});
 let output='',error='';let resolveReady:()=>void;const ready=new Promise<void>(r=>resolveReady=r);
 child.stdout.on('data',b=>{output+=b; if(output.includes('ready\n'))resolveReady();});child.stderr.on('data',b=>error+=b);
 const done=new Promise<any>((res,rej)=>{child.on('error',rej);child.on('exit',c=>{if(c!==0)rej(Error(error));else res(JSON.parse(output.trim().split('\n').at(-1)!));});});
 return {child,ready,done};
}
const a=contestant(addA),b=contestant(addB);await Promise.all([a.ready,b.ready]);a.child.stdin.write('go');b.child.stdin.write('go');
const results=await Promise.all([a.done,b.done]);
assert.equal(results.filter(r=>r.revision===2).length,1);assert.equal(results.filter(r=>r.code==='revision_conflict').length,1);
assert.equal(store.getState(account).revision,2);
const snapshot=()=>JSON.stringify({state:store.getState(account),active:store.listActive(account)});
const before=snapshot(),bytesBefore=store.listActive(account).map(i=>sha256(store.readAudio(account,i.id,i.format)!));
// 子进程在真实 SQLite 写事务内中断；未提交的 active/revision 变化必须自动回滚。
const crasher=join(dir,'crash.mjs');writeFileSync(crasher,`import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync(process.env.PROFILE_DB_PATH);db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE local_audio_item SET active=0 WHERE account_id=?').run(${JSON.stringify(account)});db.prepare('UPDATE local_audio_state SET revision=999 WHERE account_id=?').run(${JSON.stringify(account)});process.kill(process.pid,'SIGKILL');`);
await new Promise<void>((res,rej)=>{const c=spawn(process.execPath,[crasher],{env:process.env,stdio:'ignore'});c.on('error',rej);c.on('exit',(_code,signal)=>{assert.equal(signal,'SIGKILL');res();});});
assert.equal(snapshot(),before);assert.deepEqual(store.listActive(account).map(i=>sha256(store.readAudio(account,i.id,i.format)!)),bytesBefore);
// 同字节不同 ID 按实际下载总量相加；35种槽包含全部21固定槽。
const allSmall=[...LOCAL_AUDIO_SLOTS.flatMap(slot=>[0,1].map(n=>stage(slot,`容量${n}`))),...DEVICE_REPLY_SLOTS.map(slot=>stage(slot,'固定短句')),...G1_SETTINGS_SLOTS.map(slot=>stage(slot,'固定引导'))];
assert.equal(allSmall.length,49);
assert.equal(store.commitSet(account,allSmall.map(i=>({slot:i.slot,id:i.id})),gen,{expectedRevision:2}),3);
const smallSnapshot=snapshot();
const allLarge=[...LOCAL_AUDIO_SLOTS.flatMap(slot=>[0,1].map(n=>stage(slot,`大容量${n}`,slot==='greeting.normal'?1800:slot.startsWith('posture.')?3200:slot.startsWith('farewell.')?2800:2200))),
 ...DEVICE_REPLY_SLOTS.map(slot=>stage(slot,'长固定短句',3200)),...G1_SETTINGS_SLOTS.map(slot=>stage(slot,'长固定引导',slot.endsWith('intro')?8000:slot.endsWith('exit')?5500:3000))];
assert.ok(allLarge.reduce((sum,i)=>sum+i.bytes,0)>5*1024*1024);
assert.throws(()=>store.commitSet(account,allLarge.map(i=>({slot:i.slot,id:i.id})),gen,{expectedRevision:3}),e=>(e as any).code==='publication_size_limit');
assert.equal(snapshot(),smallSnapshot);
console.log('local-audio-concurrency: two processes one winner / SIGKILL rollback / 21 fixed slots + shared-byte capacity PASS');
