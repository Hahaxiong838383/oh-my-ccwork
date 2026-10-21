import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchAvailability } from '../src/tools/search-availability.js';
test('402/429立即暂停新搜索；连续上游错误熔断；成功与期限可恢复',()=>{
 let now=1000;const a=new SearchAvailability(()=>now);
 assert.equal(a.available(),true);a.failure('upstream_402');assert.equal(a.available(),false);assert.equal(a.state().reason,'upstream_402');
 now+=300001;assert.equal(a.available(),true);a.failure('upstream_429');assert.equal(a.available(),false);
 now+=30001;assert.equal(a.available(),true);a.failure('upstream_500');a.failure('upstream_503');assert.equal(a.available(),true);
 a.success();a.failure('upstream_502');assert.equal(a.available(),true);a.failure('upstream_503');a.failure('upstream_504');assert.equal(a.available(),false);
 now+=30001;assert.equal(a.available(),true);
});
