import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {probePreflight,chatHeaders} from './probe-preflight.mjs';
const root=mkdtempSync(join(tmpdir(),'p003-clock-preflight-'));
const env={PORT:'3001',AUTH_JWT_SECRET:'synthetic-only',DEVICES_DB_PATH:join(root,'devices.db'),CONVERSATION_DB_PATH:join(root,'conversation.db'),CLOCK_PROBE_RESULT:join(root,'result.json')};
const d=new DatabaseSync(env.DEVICES_DB_PATH);d.exec('CREATE TABLE device_registry(sn TEXT,note TEXT,status TEXT,account_id TEXT,public_id TEXT,created_at INTEGER,updated_at INTEGER)');d.close();
const c=new DatabaseSync(env.CONVERSATION_DB_PATH);c.exec('CREATE TABLE conversation(account_id TEXT,memory_excluded INTEGER)');c.close();
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const before=[hash(env.DEVICES_DB_PATH),hash(env.CONVERSATION_DB_PATH)];
try {
 await test('main pool optional API key: no undefined Bearer header',()=>{const r=probePreflight(env,root);assert.equal(r.key,undefined);assert.deepEqual(chatHeaders(r.key),{'Content-Type':'application/json'});});
 await test('configured key is trimmed and retained',()=>{const r=probePreflight({...env,CUSTOM_LLM_API_KEY:' fixture-key '},root);assert.equal(chatHeaders(r.key).Authorization,'Bearer fixture-key');});
 await test('blank key follows optional-auth route semantics',()=>{assert.equal(probePreflight({...env,CUSTOM_LLM_API_KEY:'  '},root).key,'');assert.equal(chatHeaders('').Authorization,undefined);});
 await test('missing authority rejected',()=>assert.throws(()=>probePreflight({...env,AUTH_JWT_SECRET:''},root),/AUTH_JWT_SECRET/));
 await test('invalid port rejected',()=>{for(const p of ['0','65536','3001.2','NaN'])assert.throws(()=>probePreflight({...env,PORT:p},root),/PORT/);});
 await test('missing DB is not created',()=>{const p=join(root,'absent.db');assert.throws(()=>probePreflight({...env,DEVICES_DB_PATH:p},root));assert(!existsSync(p));});
 await test('schema drift rejected without migration',()=>assert.throws(()=>probePreflight({...env,CONVERSATION_DB_PATH:env.DEVICES_DB_PATH},root),/schema mismatch/));
 await test('missing output directory rejected before mutation',()=>assert.throws(()=>probePreflight({...env,CLOCK_PROBE_RESULT:join(root,'missing/result.json')},root)));
 await test('DB bytes unchanged and no result artifact written',()=>{assert.deepEqual([hash(env.DEVICES_DB_PATH),hash(env.CONVERSATION_DB_PATH)],before);assert(!existsSync(env.CLOCK_PROBE_RESULT));});
} finally {rmSync(root,{recursive:true,force:true});}
