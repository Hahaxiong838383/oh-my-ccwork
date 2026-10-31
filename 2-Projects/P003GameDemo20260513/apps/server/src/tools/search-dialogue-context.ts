import { z } from 'zod';
import type { SearchOwner } from './search-tasks.js';
const schema=z.object({protocol:z.literal(1),task_id:z.string().uuid(),revision:z.number().int().positive(),
 phase:z.enum(['running','ready','playing','interrupted']),dialogue_epoch:z.number().int().nonnegative(),resume_grant:z.string().uuid().optional()}).strict();
/** No user/provider text enters the system prompt; no network or registry read on chat path. */
export function searchDialogueInstruction(value:unknown,owner:SearchOwner|null,verify:(o:SearchOwner,id:string,revision:number,grant?:string)=>boolean):string {
 if(!owner)return '';const parsed=schema.safeParse(value);if(!parsed.success)return '';
 const v=parsed.data;if(!verify(owner,v.task_id,v.revision,v.resume_grant))return '';
 const state={running:'后台正在查询',ready:'后台查询已有结果',playing:'刚才正在播报查询结果',interrupted:'刚才的查询播报被打断'}[v.phase];
 return `本轮临时对话阶段：${state}。只回应用户本轮明确意图；若只是短附和或话没说完，简短确认或询问想继续聊什么。不要自行接回搜索之前闲聊中的旧问题。此阶段不提供搜索事实，不得据此编造查到的内容。`;
}
/** Exact incomplete utterances only. Real replay showed a prompt alone still answered stale history. */
export function searchDialogueClarification(text:string):string|null {
 const normalized=text.trim().replace(/[，。！？,.!?\s]+$/u,'');
 return ['我','我想','我想聊','我想聊聊','想聊','想聊聊','我想问','我想问一下','我想说','嗯','嗯嗯','哦','哦哦'].includes(normalized)?'我在听，你想聊什么？':null;
}
