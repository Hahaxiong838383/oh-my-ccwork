import assert from 'node:assert/strict';
import {test} from 'node:test';import {readFileSync} from 'node:fs';
import {snapshotSchema} from '../src/ark/contracts.js';
import {validArkSnapshot} from './storage-nas-verify.mjs';
const sample=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
test('NAS offline v1 validator agrees with live schema on field mutations and reward cross-products',()=>{
 let n=0;
 const check=(s:any)=>{assert.equal(validArkSnapshot(s),snapshotSchema.safeParse(s).success,JSON.stringify(s));n++;};
 check(sample);
 const fields=[['schema_version'],['snapshot_id'],['captured_at_ms'],['boot_id'],['boot_started_at_ms'],['sequence'],['logical_day'],['config_revision'],['content_version'],['source_mode'],['wallets','family_coin'],['wallets','stardust'],['inventory','M-CARD-001'],['progress','timer_state'],['progress','claimable_count'],['progress','next_reward','stage_id']];
 for(const keys of fields)for(const v of [null,undefined,true,{},[],0,-1,1,1.5,Number.MAX_SAFE_INTEGER,8e12,1e9,1e9+1,'','bad space','2026-02-30']){const s=structuredClone(sample);let o=s;for(const k of keys.slice(0,-1))o=o[k];o[keys.at(-1)!]=v;check(s);}
 for(const status of ['locked','claimable','claimed','day_complete','unknown'])for(const kind of ['currency','item','chest','unknown'])for(const item of ['C-FAMILY-001','M-CARD-001',null])for(const seconds of [null,0,1]){const s=structuredClone(sample);s.progress.next_reward={status,kind,item_id:item,stage_id:null,remaining_seconds:seconds};s.progress.claimable_count=1;check(s);}
 console.log('schema comparison cases',n);
});
