import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {serve} from '@hono/node-server';
import {Hono} from 'hono';
import {wordPublications} from './word-publications';
import {recentTurnTimings} from './turn-timing';
import type {HotwordKind} from '../../../P003GameDemo20260513/apps/server/src/hotword-store';

test('私人词表的发布、陈旧草稿、回滚及 worker 回读，延时轮次按真实事件合并',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'private-word-timing-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const publication=join(dir,'interaction.json'),receipt=join(dir,'words-receipt.json');
  const draftWords:Partial<Record<HotwordKind,string[]>>={asr:['小可',' 北京 ','小可'],exit:['回头聊']};
  const getDraft=(kind:HotwordKind)=>{
    const words=draftWords[kind];
    return words?{id:1,version:0,status:'draft' as const,kind,words,created_at:0,published_at:null,note:'',created_by:'fixture'}:null;
  };
  const app=new Hono();
  app.route('/api/word-publications',wordPublications(publication,receipt,getDraft));
  app.get('/api/turn-timing',c=>c.json(recentTurnTimings(dir)));
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
  if (!server.listening) await once(server,'listening');
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve())));
  const url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/';
  async function request(path:string,payload?:object,status=200){
    const r=await fetch(url+path,payload && {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;
  }
  const list=()=>request('word-publications');
  const publish=(payload:object,status=200)=>request('word-publications',payload,status);
  const before=await list();
  assert.deepEqual(before.current,{revision:0,at:null,words:{}});
  assert.equal(before.last,null);assert.deepEqual(before.history,[]);
  assert.deepEqual(before.drafts.asr.words,draftWords.asr);
  assert.equal(before.drafts.interrupt,null);
  const asrToken=before.drafts.asr.token;
  await publish({kind:'asr',previous:0,token:'stale'},409);
  assert.deepEqual((await list()).current,before.current);
  assert.deepEqual(await publish({kind:'asr',previous:0,token:asrToken}),{revision:1});
  let latest=await list();
  assert.deepEqual(latest.current.words,{asr:['小可','北京']});
  assert.deepEqual(JSON.parse(readFileSync(publication,'utf8')).current,latest.current);
  assert.equal(latest.last,null);
  const exitToken=latest.drafts.exit.token;
  draftWords.exit=['回头聊','晚安'];
  await publish({kind:'exit',previous:1,token:exitToken},409);
  await publish({kind:'exit',previous:0,token:(await list()).drafts.exit.token},409);
  await publish({kind:'exit',previous:1,token:(await list()).drafts.exit.token});
  latest=await list();
  assert.deepEqual(latest.current.words,{asr:['小可','北京'],exit:['回头聊','晚安']});
  assert.deepEqual(latest.history.map((r:{revision:number})=>r.revision),[1,0]);
  await publish({previous:2,restore:55},404);
  await publish({previous:2,restore:1});
  latest=await list();
  assert.deepEqual(latest.current.words,{asr:['小可','北京']});assert.equal(latest.current.revision,3);
  assert.deepEqual(latest.history[0].words.exit,['回头聊','晚安']);
  draftWords.asr=['嗯'];
  await publish({kind:'asr',previous:3,token:(await list()).drafts.asr.token},400);
  assert.equal((await list()).current.revision,3);
  const at=Date.now();
  writeFileSync(receipt,'{');assert.equal((await list()).last,null);
  writeFileSync(receipt,JSON.stringify({at,revision:2,cloudAsr:true,other:'unused'}));
  assert.deepEqual((await list()).last,{at,revision:2,cloudAsr:true});
  writeFileSync(receipt,JSON.stringify({at,revision:null,cloudAsr:false}));
  assert.deepEqual((await list()).last,{at,revision:null,cloudAsr:false});

  assert.deepEqual(await request('turn-timing'),{items:[]});
  const first='pv-'+'1'.repeat(32),second='pv-'+'2'.repeat(32);
  const sample=(room:string,turn:number,stage:string,ms:number,timestamp:number)=>JSON.stringify({room,turn,stage,ms,at:timestamp,transcript:'never include audio content'});
  writeFileSync(join(dir,'turn-timing.previous'),[
    sample(first,1,'commit',45,at-80),sample(first,1,'asr_final',65,at-70),sample(first,1,'speakable',100,at-60),
    sample(first,3,'commit',5,at-8*86400000),sample(second,1,'commit',0,at-50)
  ].join('\n'));
  writeFileSync(join(dir,'turn-timing.jsonl'),[
    sample(first,1,'first_audio',120,at-30),sample(first,2,'first_audio',440,at-10),
    sample(second,1,'asr_final',15,at-20),sample(second,1,'first_audio',-1,at),
    sample('other',1,'commit',1,at),sample(second,1,'arbitrary-stage',8,at),'{'
  ].join('\n'));
  assert.deepEqual((await request('turn-timing')).items,[
    {at:at-20,room:second,turn:1,commit:0,asr_final:15,speakable:null,first_audio:null,post_filler_audio:null},
    {at:at-30,room:first,turn:1,commit:45,asr_final:65,speakable:100,first_audio:120,post_filler_audio:null}
  ]);
});

test('白盒只按房间和轮号读取：跨文件冲突留空，相同采样重投保持，其他房间同号互不影响', t => {
  const dir=mkdtempSync(join(tmpdir(),'private-timing-identity-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const room='pv-'+'a'.repeat(32), other='pv-'+'b'.repeat(32), now=Date.now()-1000;
  const line=(room:string,turn:number,stage:string,ms:number,at:number)=>JSON.stringify({room,turn,stage,ms,at});
  assert.deepEqual(recentTurnTimings(dir,room).items,[]);
  writeFileSync(join(dir,'turn-timing.previous'),[
    line(room,2,'commit',7,now),line(room,2,'first_audio',130,now+1),
    line(room,3,'commit',3,now+2),line(room,3,'asr_final',45,now+3),
    line(other,2,'commit',40,now+4)
  ].join('\n'));
  writeFileSync(join(dir,'turn-timing.jsonl'),[
    line(room,2,'first_audio',260,now+5),line(room,2,'first_audio',130,now+6),
    line(room,3,'asr_final',45,now+7),line(other,2,'first_audio',0,now+8),
    line(room,4,'first_audio',19,now+9),line(room,5,'commit',9,now-8*86400000)
  ].join('\n'));
  assert.deepEqual(recentTurnTimings(dir,room).items,[
    {room,turn:3,at:now+7,commit:3,asr_final:45,speakable:null,first_audio:null,post_filler_audio:null}
  ]);
  assert.deepEqual(recentTurnTimings(dir,other).items,[
    {room:other,turn:2,at:now+8,commit:40,asr_final:null,speakable:null,first_audio:0,post_filler_audio:null}
  ]);
  assert.deepEqual(recentTurnTimings(dir,'pv-'+'c'.repeat(32)).items,[]);
});

test('白盒按房读取全部仍在保留期的轮次，公共时序列表保持最新40条', t => {
  const dir=mkdtempSync(join(tmpdir(),'private-timing-window-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const room='pv-'+'a'.repeat(32), newer='pv-'+'b'.repeat(32), now=Date.now()-1000;
  const lines=(room:string,base:number)=>Array.from({length:45},(_,i)=>JSON.stringify({room,turn:i+1,stage:'commit',ms:i,at:base+i}));
  writeFileSync(join(dir,'turn-timing.previous'),lines(room,now).join('\n'));
  writeFileSync(join(dir,'turn-timing.jsonl'),lines(newer,now+100).join('\n'));
  assert.deepEqual(recentTurnTimings(dir).items.map(i=>[i.room,i.turn]),
    Array.from({length:40},(_,i)=>[newer,45-i]));
  assert.deepEqual(recentTurnTimings(dir,room).items.map(i=>[i.room,i.turn,i.commit]),
    Array.from({length:45},(_,i)=>[room,45-i,44-i]));
});
