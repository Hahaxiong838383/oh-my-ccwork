// Run from scripts/ of the fixed, private 856552b9 server archive.
// Synthetic cases only; no production requests, ASR calls, or external models.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {answerArk} from '../src/ark/answer.js';
import {resolveArkFacts} from '../src/ark/context.js';
import {isArkStateQuestion,buildKnowledgeRecall} from '../src/xiaoke-kb.js';
import {containsArkDynamicData,stripArkDynamicTurns} from '../src/ark/memory-policy.js';
import {cstDay,type ArkSnapshot} from '../src/ark/contracts.js';
const now=1793701800000;
function facts(card:number|null,source:'normal'|'gm'|'unknown'='normal'){
 const snapshot:ArkSnapshot={schema_version:1,snapshot_id:'synthetic-card',boot_id:'synthetic-boot',boot_started_at_ms:now-60000,captured_at_ms:now,sequence:1,logical_day:cstDay(now),config_revision:'synthetic-rules',content_version:'synthetic-v380',source_mode:source,wallets:{family_coin:null,stardust:null},inventory:{'M-CARD-001':card},progress:{timer_state:'paused',claimable_count:0,next_reward:{status:'locked',kind:'chest',item_id:null,stage_id:'FIRST-03',remaining_seconds:300}}};
 return resolveArkFacts({snapshot:{snapshot,received_at_ms:now},history:null},now);
}
test('standard name and supported alias have the same bounded use explanation',()=>{
 const a=answerArk('补勤卡有什么用',undefined,[],now),b=answerArk('补签卡有什么用',undefined,[],now);
 assert.equal(a,b);assert.match(a!,/符合条件.*历史航线节点补签/);assert.match(a!,/奖励.*页面.*领取/);
 for(const q of ['补勤卡怎么用','补签卡有什么用'])assert.match(buildKnowledgeRecall(q)!,/不承诺所有日期都可补/);
});
test('both inventory phrasings route and use the precise card count',()=>{
 for(const q of ['我有几张补勤卡','我还有多少补签卡']){assert.equal(isArkStateQuestion(q),true);assert.match(answerArk(q,facts(3),[],now)!,/上次同步.*补勤卡库存是3张/);}
});
test('authoritative zero is distinct from unknown, independently of unknown wallets',()=>{
 assert.match(answerArk('我有几张补勤卡',facts(0),[],now)!,/库存是0张/);
 assert.match(answerArk('我有几张补勤卡',facts(null),[],now)!,/暂时查不到/);
});
test('GM and unknown inventory never becomes normal inventory',()=>{
 for(const source of ['gm','unknown'] as const){const f=facts(99,source);assert.equal(f.assets.makeup_card,null);assert.match(answerArk('我有几张补勤卡',f,[],now)!,/暂时查不到/);}
});
test('requesting next card does not relabel a chest or promise wall-clock delivery',()=>{
 const a=answerArk('补勤卡还要多久才能领取',facts(1),[],now)!;
 assert.match(a,/暂停.*下一项是宝箱.*5分钟有效使用时间/);assert.match(a,/不是你问的那一种奖励/);assert.doesNotMatch(a,/自动到账|下一项是补勤卡/);
 assert.match(answerArk('补勤卡还要多久才能领取',facts(1),[],now+30001)!,/暂时查不到/);
});
test('synthetic near-sound and unrelated-card negatives do not route to Ark',()=>{
 for(const q of ['父亲节要做什么','我们步行去学校','今天不请客','我想去补课','这个考勤卡怎么用','我有几张补课卡']){assert.equal(isArkStateQuestion(q),false,q);assert.equal(answerArk(q,facts(1),[],now),null,q);}
});
test('translation and fictional card contexts do not get authoritative inventory answers',()=>{
 for(const q of ['把补勤卡翻译成英语','故事里的补勤卡有几张']){assert.equal(isArkStateQuestion(q),false,q);assert.equal(answerArk(q,facts(1),[],now),null,q);}
});
test('use request cannot return a finite-route action-success claim',()=>{
 assert.equal(answerArk('帮我用一张补勤卡',facts(1),[],now),null);
 assert.match(buildKnowledgeRecall('帮我用一张补勤卡')!,/不声称已替孩子使用道具/);
});
test('dynamic card counts and their followups are excluded from profile extraction',()=>{
 const turns=[{role:'user',content:'我有几张补勤卡'},{role:'assistant',content:answerArk('我有几张补勤卡',facts(3),[],now)!},{role:'user',content:'那现在呢'},{role:'assistant',content:'补勤卡库存暂时查不到'},{role:'user',content:'我喜欢画画'},{role:'assistant',content:'你喜欢画什么'}];
 assert.equal(containsArkDynamicData(turns),true);assert.deepEqual(stripArkDynamicTurns(turns),turns.slice(4));
});
