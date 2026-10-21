import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchTasks } from '../src/tools/search-tasks.js';
const owner={subject:'BJP00326070803800006',session:'sn-BJP00326070803800006-1'};
const input=(turn:string)=>({protocol:1,phase:'committed',turn,query:'科技馆开放时间'});
test('队列满时修改查询失败不取消原任务',()=>{
 const dir=mkdtempSync(join(tmpdir(),'search-boundary-'));
 const t=new SearchTasks({dbPath:join(dir,'t.db'),enabled:()=>true,allowed:()=>true,queueLimit:1,concurrency:1,execute:()=>new Promise(()=>{})});
 try{
  const a=t.submit(owner,input('1')); t.submit({...owner,session:owner.session+'2'},input('2'));
  assert.throws(()=>t.submit(owner,{...input('3'),replace:a.id}),/queue_full/);
  assert.equal(t.get(owner,a.id).status,'running');
 }finally{t.close();rmSync(dir,{recursive:true,force:true});}
});
test('已播结果只在原有效期内可续讲，撤销设备或会话退出后不可续讲',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'search-resume-'));let now=1_800_000_000_000,allowed=true;
 const t=new SearchTasks({dbPath:join(dir,'t.db'),enabled:()=>true,allowed:()=>allowed,now:()=>now,execute:async()=>({text:'科技馆安排。',sources:[]})});
 try{
  const a=t.submit(owner,input('1'));await new Promise(r=>setImmediate(r));t.claim(owner,a.id,'delivery');t.receipt(owner,a.id,'delivery','interrupted');
  assert.equal(t.resumable(owner,a.id).result?.text,'科技馆安排。');
  allowed=false;assert.throws(()=>t.resumable(owner,a.id),/disabled/);allowed=true;
  now+=300_001;assert.throws(()=>t.resumable(owner,a.id),/not_ready/);assert.equal(t.get(owner,a.id).result,undefined);
  const b=t.submit(owner,input('2'));await new Promise(r=>setImmediate(r));t.claim(owner,b.id,'d2');t.receipt(owner,b.id,'d2','completed');
  t.cancelSession(owner);assert.throws(()=>t.resumable(owner,b.id),/not_ready|session_closed/);
 }finally{t.close();rmSync(dir,{recursive:true,force:true});}
});
