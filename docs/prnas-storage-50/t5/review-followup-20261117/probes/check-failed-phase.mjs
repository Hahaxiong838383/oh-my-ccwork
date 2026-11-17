import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
const dir=realpathSync(mkdtempSync(join(tmpdir(),'p003-t5-missing-index-'))),dbPath=join(dir,'analytics.db');
const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE analytics_event(device_key TEXT)');db.close();
const results=[];
try{
 for(const [label,path,expected] of [
 ['original',new URL('./original-profile-first-request.mjs',import.meta.url).pathname,0],
 ['fixed',new URL('./profile-first-request.mjs',import.meta.url).pathname,4]]){
  const r=spawnSync(process.execPath,[path,dbPath],{encoding:'utf8',env:{...process.env,T5_PROFILE_ALLOW_SMALL:'1'}});const v=JSON.parse(r.stdout);
  const errors=v.phases.filter(p=>p.error);assert.ok(errors.length);assert.equal(r.status,expected);assert.equal(v.ok,label==='original');
  results.push({label,exit:r.status,reported_ok:v.ok,phase_errors:errors.map(({name,error})=>({name,error}))});
 }
 console.log(JSON.stringify({pass:true,results},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
