import assert from 'node:assert/strict';
export function assertOrdinaryReply(row){
 assert(!row.clock_response);
 assert.equal(typeof row.spoken,'string');
 assert(row.spoken.trim().length>0,'ordinary response must contain content');
 assert.doesNotMatch(row.spoken,/小可暂时连不上大脑|小可有点累了/);
}
