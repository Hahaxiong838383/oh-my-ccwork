import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchDialogueInstruction, searchDialogueClarification } from '../src/tools/search-dialogue-context.js';
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
