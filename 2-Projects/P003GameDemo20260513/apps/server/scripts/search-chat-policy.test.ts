import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchChatPolicy } from '../src/tools/search-chat-policy.js';
const input={candidate:true,enabled:true,role:'device',room:'sn-BJP00326060100100004-1',allowed:['BJP00326060100100004']};
test('search chat capabilities and onboarding suppression apply only to active candidate device',()=>{
 assert.equal(searchChatPolicy(input).suppressOnboarding,true);
 assert.ok(searchChatPolicy(input).instruction.length>0);
 for(const patch of [{candidate:false},{enabled:false},{role:'parent'},{room:'sn-BJP00326070803800006-1'},{allowed:[]}]){
  assert.deepEqual(searchChatPolicy({...input,...patch}),{suppressOnboarding:false,instruction:''});
 }
});
