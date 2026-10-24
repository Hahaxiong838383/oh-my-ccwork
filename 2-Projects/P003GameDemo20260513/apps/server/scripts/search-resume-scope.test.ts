import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readResumeAuthority} from '../src/tools/search-resume-scope.js';
test('R14 authority uses current production epoch and revocation even when candidate binding stays unchanged',()=>{
 const dir=mkdtempSync(join(tmpdir(),'resume-auth-'));const path=join(dir,'devices.db');const db=new DatabaseSync(path);
 try{db.exec(`CREATE TABLE device_registry(sn TEXT,status TEXT,account_id TEXT,parent_account_id TEXT,updated_at INTEGER);CREATE TABLE device_credential_revocation(sn TEXT,not_before_sec INTEGER,updated_at INTEGER);INSERT INTO device_registry VALUES('SN','active','A','parentA',1)`);
 const first=readResumeAuthority(path,'SN','candidate-A');assert.ok(first);assert.equal(readResumeAuthority(path,'SN','candidate-A'),first);
 db.exec("UPDATE device_registry SET account_id='B',updated_at=2");assert.notEqual(readResumeAuthority(path,'SN','candidate-A'),first);
 db.exec("UPDATE device_registry SET account_id='A',updated_at=3");assert.notEqual(readResumeAuthority(path,'SN','candidate-A'),first);
 const rebound=readResumeAuthority(path,'SN','candidate-A');db.exec("INSERT INTO device_credential_revocation VALUES('SN',100,4)");assert.notEqual(readResumeAuthority(path,'SN','candidate-A'),rebound);
 db.exec("UPDATE device_registry SET status='disabled'");assert.equal(readResumeAuthority(path,'SN','candidate-A'),null);
 assert.equal(readResumeAuthority(join(dir,'missing.db'),'SN','candidate-A'),null);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
