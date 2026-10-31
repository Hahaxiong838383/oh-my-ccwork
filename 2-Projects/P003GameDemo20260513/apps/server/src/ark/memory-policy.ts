import {isArkStateQuestion} from '../xiaoke-kb.js';
type Turn={role:string;content:string;memory_excluded?:boolean};
const transientAnswer=(s:string)=>/(?:还(?:有|需|剩)|剩余|约)\s*\d+\s*(?:分钟|分|秒)/.test(s);
const numericAnswer=(s:string)=>transientAnswer(s)||/(金币|家族币|星尘|星辰|宝箱|有效专注|库存)/.test(s)&&/(余额|库存|剩余|还[有需]|可领取|已领取|分钟|秒|同步|未知|查不到)/.test(s);
const shortFollowup=(text:string)=>text.length<=20&&/^(那(?:么)?(?:现在|还|要|多久|多少|能领|可领)|现在呢|现在还有|还要多久|还有多久|多久|多少|领了吗|可以领了吗)/.test(text.trim());
export function containsArkDynamicData(turns:Turn[]){return turns.some(t=>t.memory_excluded||(t.role==='user'?isArkStateQuestion(t.content):numericAnswer(t.content)));}
export function isArkFollowup(text:string,history:Turn[]){
 if(!shortFollowup(text))return false;
 let active=false;for(const t of history)if(t.role==='user')active=isArkStateQuestion(t.content)||(active&&shortFollowup(t.content));
 return active;
}
export function stripArkDynamicTurns<T extends Turn>(turns:T[]):T[]{
 let active=false;return turns.filter(t=>{if(t.role==='user')active=isArkStateQuestion(t.content)||(active&&shortFollowup(t.content));return !active&&!(t.role==='assistant'&&numericAnswer(t.content));});
}
