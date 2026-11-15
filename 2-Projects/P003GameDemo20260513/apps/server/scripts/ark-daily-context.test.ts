import {test} from 'node:test';
import assert from 'node:assert/strict';
const now=Date.parse('2026-11-15T14:00:00+08:00');
test('daily facts cannot escape a GM/unknown snapshot; maximum payload remains inside proxy budget',async()=>{
 const {resolveArkFacts,formatArkFacts}=await import('../src/ark/context.js');
 const daily={logical_day:'2026-11-15',observed_at_ms:now,received_at_ms:now,coverage:'received_records' as const,progress_seconds:600,rewards:Array.from({length:32},(_,i)=>({item_id:'ITEM-'+String(i).padStart(2,'0')+'x'.repeat(54),quantity:1000000000}))};
 const history:any={ok:true,status:'available',reason:'none',wallets:{family_coin:null,stardust:null},inventory:{'M-CARD-001':null},daily};
 const snapshot:any={snapshot:{source_mode:'gm',wallets:{family_coin:99,stardust:22},inventory:{'M-CARD-001':1}},received_at_ms:now};
 assert.equal(resolveArkFacts({snapshot,history},now).daily,undefined);
 const input={snapshot:null,history};const facts=resolveArkFacts(input,now),prompt=formatArkFacts(input,now);
 assert.ok(Buffer.byteLength(JSON.stringify({ok:true,prompt,facts_v1:{subject:'BJP00399999999999901',...facts}}))<8192);
});
