import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {safeIdentifier,validateAnalyticsEvent} from '../src/analytics/contracts.js';
import {syntheticSessionId} from './storage-synthetic-identifiers.js';
test('reproduce actor37 all-event rejection; synthetic IDs pass the unchanged privacy contract',()=>{
 const seed='load-t5-17-1794949895955-37',old=createHash('sha256').update(seed).digest('hex').slice(0,32);
 assert.equal(old,'3c13631290378a8de892748812329e1c');assert.equal(safeIdentifier(old,64),false);
 const catalog=JSON.parse(readFileSync(new URL('../src/analytics/event-property-schema-v1.json',import.meta.url),'utf8')).events;
 for(const [n,spec]of catalog.entries()){
  const event={schema_version:1,client_event_id:seed+'-'+n,event_name:spec.eventName,occurred_at_ms:1794949872051,session_id:old,sequence:n,priority:'normal',context:{},properties:spec.sample};
  assert.deepEqual(validateAnalyticsEvent(event),{ok:false,reason:'invalid_event'});
  assert.equal(validateAnalyticsEvent({...event,session_id:syntheticSessionId(seed)}).ok,true,spec.eventName);
 }
 const ids=Array.from({length:10000},(_,n)=>syntheticSessionId('synthetic-run-'+n));
 assert.equal(new Set(ids).size,ids.length);for(const id of ids){assert.match(id,/^[a-p]{32}$/);assert(safeIdentifier(id,64));}
 assert.equal(safeIdentifier('13800138000',64),false,'production privacy admission is unchanged');
});
