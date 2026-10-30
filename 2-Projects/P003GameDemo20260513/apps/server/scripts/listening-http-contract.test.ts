import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseListeningRequest } from '../src/listening-http-contract.js';
const fixtures=JSON.parse(readFileSync(new URL('../../../../../4-Assets/contracts/p003-listening-http-v1.fixtures.json',import.meta.url),'utf8'));
for(const f of fixtures.valid) test('frozen wire accepts '+f.name,()=>assert.ok(parseListeningRequest(f.path,f.body)));
for(const f of fixtures.invalid) test('frozen wire rejects '+f.name,()=>assert.equal(parseListeningRequest(f.path,f.body),null));
test('summary rejects noncontiguous coverage and total source over limit',()=>{
 const f=fixtures.valid.find((x:any)=>x.name==='summary').body;
 assert.equal(parseListeningRequest('/summary',{...f,segments:[{seq:1,revision:1,text:'甲'},{seq:3,revision:1,text:'乙'}]}),null);
 assert.equal(parseListeningRequest('/summary',{...f,segments:[{seq:1,revision:1,text:'甲'.repeat(12001)}]}),null);
});
test('feedback Unicode limit counts codepoints and rejects oversized source',()=>{
 const f=fixtures.valid.find((x:any)=>x.name==='feedback').body;
 assert.ok(parseListeningRequest('/feedback',{...f,recent:'🌟'.repeat(4000)}));
 assert.equal(parseListeningRequest('/feedback',{...f,recent:'🌟'.repeat(4001)}),null);
});
