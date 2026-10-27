import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchDialogueInstruction, searchDialogueClarification, searchDialogueHistory } from '../src/tools/search-dialogue-context.js';
const owner={subject:'BJP00326060100100004',session:'sn-BJP00326060100100004-1'};
const input={protocol:1,task_id:'00000000-0000-4000-8000-000000000001',revision:1,phase:'interrupted',dialogue_epoch:2};
test('R14 context never accepts free text, foreign ownership or anonymous requests',()=>{
 for(const v of [{...input,text:'raw web text'},{...input,phase:'invented'},null])assert.equal(searchDialogueInstruction(v,owner,()=>true),'');
 assert.equal(searchDialogueInstruction(input,null,()=>true),'');
 assert.equal(searchDialogueInstruction(input,owner,()=>false),'');
 const copy=structuredClone(input);assert.match(searchDialogueInstruction(input,owner,()=>true),/不要自行接回/);assert.deepEqual(input,copy);
});

test('R14 observed incomplete utterance cannot replay an old cat question',()=>{
 for(const text of ['我想聊','我想聊。','我想问','我'])assert.equal(searchDialogueClarification(text),'我在听，你想聊什么？');
 for(const text of ['我想聊小猫','我想问火星为什么是红色','继续刚才的搜索结果','取消搜索','退出'])assert.equal(searchDialogueClarification(text),null);
});
test('R20 explicit search follow-up excludes stale chat without erasing ordinary conversation',()=>{
 const history=[{role:'user' as const,content:'我想在方舟里踢球'},{role:'assistant' as const,content:'你想在哪踢球？'}];
 const answer='双打发球不能超过后发球线。';
 for(const q of ['那我发到那条线外是不是就出界了','那恐龙为什么不自己找吃的','所以你的意思是发过那条线就不行吗']){
  const sent=searchDialogueHistory(history,answer,q);assert.equal(sent.length,1);assert.ok(!JSON.stringify(sent).includes('方舟'));assert.ok(JSON.stringify(sent).includes(answer));
 }
 for(const q of ['我今天打球赢了','那我们聊聊动漫','那我刚才说想在哪里踢球','我刚才说喜欢什么'])assert.equal(searchDialogueHistory(history,answer,q).length,3,q);
 assert.equal(searchDialogueHistory(history,'','那条线外呢'),history);
 assert.equal(history.length,2,'stored history must remain intact');
});
