/** Retry only SQLite BUSY, after yielding the HTTP loop. No persistent queue. */
export async function retryArkBusy<T>(run:(retry:boolean)=>Promise<T>):Promise<T>{
 const started=performance.now(),budgetMs=80,sqliteBusyMs=15;
 for(let attempt=0;;attempt++){
  try{return await run(attempt>0);}
  catch(error){
   const e=error as {code?:unknown;errcode?:unknown};
   if(e?.code!=='ERR_SQLITE_ERROR'||!Number.isSafeInteger(e.errcode)||((e.errcode as number)&255)!==5||attempt>=2)throw error;
   const delay=(attempt+1)*10;
   if(performance.now()-started+delay+sqliteBusyMs>budgetMs)throw error;
   await new Promise<void>(resolve=>setTimeout(resolve,delay));
   // Event-loop/scheduler delay consumes the same budget, never another retry window.
   if(performance.now()-started+sqliteBusyMs>budgetMs)throw error;
  }
 }
}
