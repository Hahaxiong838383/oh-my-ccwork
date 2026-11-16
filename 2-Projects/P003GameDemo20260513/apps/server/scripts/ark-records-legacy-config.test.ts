import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=mkdtempSync(join(tmpdir(),'legacy-config-'));process.env.CONFIG_DB_PATH=join(root,'config.db');
const {configStore}=await import('../src/config-store.js');
test('legacy upload config is explicit per device; all other snapshots remain unchanged',()=>{
 const sn='BJP00326060100009991',other='BJP00326060100009992';
 const before=configStore.effectiveSnapshot(other);assert.equal(before.ark_records,undefined);
 assert.notEqual(configStore.setValue(sn,'ark_records.enabled',true),null);
 assert.deepEqual(configStore.effectiveSnapshot(sn).ark_records,{enabled:true,contract_id:'p003-ark-records-r1'});
 assert.deepEqual(configStore.effectiveSnapshot(other),before);
 assert.equal(configStore.setGlobal('ark_records.enabled',true),null);
 assert.equal(configStore.setValue(sn,'ark_records.enabled','true'),null);
 assert.equal(configStore.setValue(sn,'ark_records.contract_id','p003.ark.records.r1'),null);
 configStore.setValue(sn,'ark_records.enabled',false);
 assert.deepEqual(configStore.effectiveSnapshot(sn).ark_records,{enabled:false,contract_id:'p003-ark-records-r1'});
});
