import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,statSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
const dir=realpathSync(mkdtempSync(join(tmpdir(),'p003-env-preparation-')));
try{
 const fixture=join(dir,'server');mkdirSync(fixture);
 const original='AUTH_JWT_SECRET="fake key with # symbol"\nOTHER_FEATURE="unchanged"\n';writeFileSync(join(fixture,'.env.local'),original,{mode:0o600});
 const code=readFileSync(new URL('./analytics-prepare-env.mjs',import.meta.url),'utf8').replaceAll('/opt/p003/server',fixture);const script=join(dir,'prepare.mjs');writeFileSync(script,code);
 const run=()=>{const r=spawnSync(process.execPath,[script],{cwd:fixture,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.ok(!r.stdout.includes('fake key'));return JSON.parse(r.stdout);};
 assert.equal(run().existing_runtime_secrets_reused,false);const first=parseEnv(readFileSync(join(fixture,'.env.analytics'),'utf8'));assert.equal(first.AUTH_JWT_SECRET,'fake key with # symbol');assert.notEqual(first.ANALYTICS_DEVICE_KEY_SECRET,first.ANALYTICS_INTERNAL_SECRET);
 const updated=readFileSync(join(fixture,'.env.local'),'utf8');assert.ok(updated.startsWith(original));assert.equal(parseEnv(updated).OTHER_FEATURE,'unchanged');
 assert.equal(run().existing_runtime_secrets_reused,true);assert.deepEqual(parseEnv(readFileSync(join(fixture,'.env.analytics'),'utf8')),first);assert.equal(readFileSync(join(fixture,'.env.local'),'utf8'),updated);
 for(const name of ['.env.analytics','data/analytics-control.json','data/analytics.db'])assert.equal(statSync(join(fixture,name)).mode&0o777,0o600);
 console.log('PASS: protected preparation retains other env bytes, secrets stable on rerun, independent keys and0600');
}finally{rmSync(dir,{recursive:true,force:true});}
