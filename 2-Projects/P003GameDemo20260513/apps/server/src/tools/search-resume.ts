import { createHash, randomUUID } from 'node:crypto';
import type { SearchOwner, SearchTask } from './search-tasks.js';

export type SearchProgress = { protocol:1; text_digest:string; complete_sentences:number; sequence:number };
export const textDigest=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Shared with Worker: boundaries are explicit punctuation; a tiny tail joins its predecessor. */
export function searchSentences(text:string):string[] {
 const parts:string[]=[];let pending='';
 for(const c of text){pending+=c;if('。！？!?；;\n'.includes(c)){parts.push(pending);pending='';}}
 if(pending){if([...pending].length<4&&parts.length)parts[parts.length-1]+=pending;else parts.push(pending);}
 return parts;
}
type Entry={task:string;scope:string;closed:boolean;cursor:number;attempts:number;grant?:Grant;sequences:Map<string,number>};
type Grant={id:string;request:string;session:string;closed:boolean;outcome?:string};
const fail=(s:string):never=>{throw new Error(s);};
/** Process-local authorization only. Restart intentionally drops every recovery capability. */
export class SearchResume {
 private entries=new Map<string,Entry>();
 constructor(private deps:{enabled:()=>boolean;scope:(o:SearchOwner)=>string|null;now:()=>number;deadline:()=>number;get:(id:string)=>SearchTask|undefined}){}
 admit(t:SearchTask) {
  this.entries.delete(t.subject);
  const scope=this.deps.enabled()?this.deps.scope(t):null;
  if(scope)this.entries.set(t.subject,{task:t.id,scope,closed:false,cursor:0,attempts:0,sequences:new Map()});
 }
 resetReplay(t:SearchTask){const e=this.entries.get(t.subject);if(e?.task===t.id&&e.cursor>=searchSentences(t.result?.text??'').length)e.cursor=0;}
 invalidate(t:SearchTask){if(this.entries.get(t.subject)?.task===t.id)this.entries.delete(t.subject);}
 private owned(o:SearchOwner){
  if(!this.deps.enabled())return fail('disabled');
  const e=this.entries.get(o.subject);if(!e)return fail('not_ready');
  const scope=this.deps.scope(o);
  if(!scope||scope!==e.scope){this.entries.delete(o.subject);return fail('not_ready');}
  const t=this.deps.get(e.task);
  if(!t?.result||!['ready','delivered'].includes(t.status)||this.deps.now()>=this.expires(t))return fail('not_ready');
  return {e,t};
 }
 private expires(t:SearchTask){return Math.min((t.readyAt??0)+300_000,this.deps.deadline());}
 private snapshot(e:Entry,t:SearchTask){
  const sentences=searchSentences(t.result!.text);
  // Fully heard results may be explicitly replayed from the beginning, never automatically.
  const cursor=e.cursor>=sentences.length?0:e.cursor;
  return {protocol:1 as const,grant:e.grant!.id,task_id:t.id,revision:t.revision,text:sentences.slice(cursor).join(''),
   text_digest:textDigest(t.result!.text),complete_sentences:cursor,valid_for_ms:Math.max(0,this.expires(t)-this.deps.now())};
 }
 close(o:SearchOwner){
  const e=this.entries.get(o.subject);if(!e)return;
  const t=this.deps.get(e.task);
  if(t?.session===o.session)e.closed=true;
  if(e.grant?.session===o.session)e.grant.closed=true;
 }
 latest(o:SearchOwner,request:string){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(request))return fail('invalid_request');
  const {e,t}=this.owned(o);
  if(e.grant?.request===request&&e.grant.session===o.session&&!e.grant.closed)return this.snapshot(e,t);
  if(!e.closed||e.grant&&!e.grant.closed&&e.grant.session!==o.session)return fail('previous_session_closing');
  if(e.attempts+(t.replays?.length??0)>=8)return fail('not_ready');
  e.attempts++;e.grant={id:randomUUID(),request,session:o.session,closed:false};
  console.info('[search-resume]',JSON.stringify({event:'grant',task_id:t.id,revision:t.revision,source_session:t.session,session:o.session,complete_sentences:e.cursor,at_ms:this.deps.now(),expires_at_ms:this.expires(t)}));
  if(e.cursor>=searchSentences(t.result!.text).length)e.cursor=0;
  return this.snapshot(e,t);
 }
 playback(o:SearchOwner,grant:string){
  const {e,t}=this.owned(o);
  if(e.grant?.id!==grant||e.grant.session!==o.session)return fail('not_found');
  if(e.grant.closed)return fail('session_closed');
  return this.snapshot(e,t);
 }
 update(t:SearchTask,delivery:string,p:SearchProgress){
  const e=this.entries.get(t.subject);
  // Recovery can be off independently. Progress still validates at the ledger boundary.
  if(!e||e.task!==t.id)return;
  const prior=e.sequences.get(delivery)??0;
  if(p.sequence<=prior)return;
  if(p.complete_sentences<e.cursor)return fail('invalid_progress');
  e.cursor=p.complete_sentences;e.sequences.set(delivery,p.sequence);
 }
 receipt(o:SearchOwner,grant:string,outcome:string,p?:SearchProgress){
  this.playback(o,grant);const {e,t}=this.owned(o);
  if(!['completed','interrupted','dropped','progress'].includes(outcome))return fail('invalid_request');
  if(e.grant!.outcome){if(outcome==='progress')return fail('not_ready');return this.snapshot(e,t);}
  if(p){validateProgress(t,p);this.update(t,grant,p);}
  if(outcome!=='progress')e.grant!.outcome=outcome;
  console.info('[search-resume]',JSON.stringify({event:'receipt',task_id:t.id,session:o.session,outcome,complete_sentences:e.cursor,sequence:p?.sequence,at_ms:this.deps.now()}));
  return this.snapshot(e,t);
 }
 cancelLatest(o:SearchOwner){const {e,t}=this.owned(o);if(e.grant&&e.grant.session!==o.session||!e.closed)return fail('not_found');this.entries.delete(o.subject);return t;}
 context(o:SearchOwner,id:string,revision:number,grant:string){
  const e=this.entries.get(o.subject);const t=e&&this.deps.get(e.task);
  return !!(this.deps.enabled()&&e&&e.scope===this.deps.scope(o)&&t&&t.id===id&&t.revision===revision&&e.grant?.id===grant&&e.grant.session===o.session&&!e.grant.closed&&
   t.result&&['ready','delivered'].includes(t.status)&&this.deps.now()<this.expires(t));
 }
}
export function validateProgress(t:SearchTask,p:SearchProgress){
 if(p.protocol!==1||!t.result||p.text_digest!==textDigest(t.result.text)||!Number.isSafeInteger(p.sequence)||p.sequence<1||
  !Number.isSafeInteger(p.complete_sentences)||p.complete_sentences<0||p.complete_sentences>searchSentences(t.result.text).length)fail('invalid_progress');
}
