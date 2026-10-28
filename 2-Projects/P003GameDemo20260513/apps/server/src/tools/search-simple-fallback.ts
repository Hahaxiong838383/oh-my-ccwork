import type {SearchResult} from './search-tasks.js';

export const SIMPLE_SEARCH_UNAVAILABLE:SearchResult={text:'这次暂时没能查到可靠的信息，我先不乱说。我们可以继续聊别的。',sources:[]};
type Attempt=(signal:AbortSignal)=>Promise<SearchResult>;
// These budgets are inside the existing 20-second task lifetime, never on chat.
// A caller cancellation is authoritative; a timed-out attempt may use the one
// remaining lookup. Late results cannot publish after Promise.race settles.
async function bounded(run:Attempt,parent:AbortSignal,ms:number):Promise<SearchResult>{
 parent.throwIfAborted();const controller=new AbortController();
 const signal=AbortSignal.any([parent,controller.signal]);let abort:()=>void=()=>{};
 const timer=setTimeout(()=>controller.abort(new DOMException('search_attempt_timeout','TimeoutError')),ms);
 try{return await Promise.race([run(signal),new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
}
export async function runSearchFallback(o:{signal:AbortSignal;primary:Attempt;fallback:Attempt;primaryMs?:number;fallbackMs?:number;audit?:(stage:'primary'|'fallback',outcome:'answered'|'empty'|'failed')=>void}):Promise<SearchResult>{
 for(const [stage,run,ms]of [['primary',o.primary,o.primaryMs??10000],['fallback',o.fallback,o.fallbackMs??7000]]as const){
  o.signal.throwIfAborted();
  try{
   const result=await bounded(run,o.signal,ms);o.signal.throwIfAborted();
   if(result.sources.length&&result.text.trim()){o.audit?.(stage,'answered');return result;}
   o.audit?.(stage,'empty');
  }catch{ o.signal.throwIfAborted();o.audit?.(stage,'failed'); }
 }
 return structuredClone(SIMPLE_SEARCH_UNAVAILABLE);
}
