/** Retry only SQLite BUSY, after yielding the HTTP loop. No persistent queue. */
export async function retryArkBusy<T>(run:(retry:boolean)=>Promise<T>):Promise<T>{
 // Each try uses busy_timeout=0; reserve 15ms of admission headroom for the
 // operation itself. This cannot bound synchronous disk I/O or scheduler pauses.
 const started=performance.now(),budgetMs=80,operationHeadroomMs=15;
 for(let attempt=0;;attempt++){
  try{return await run(attempt>0);}
  catch(error){
   const e=error as {code?:unknown;errcode?:unknown};
   if(e?.code!=='ERR_SQLITE_ERROR'||!Number.isSafeInteger(e.errcode)||((e.errcode as number)&255)!==5||attempt>=5)throw error;
   // Poll a short local lock every 10ms; exponential delay consumes this small
   // fixed window before a released lock can be observed. At most six attempts.
   const delay=10;
   if(performance.now()-started+delay+operationHeadroomMs>budgetMs)throw error;
   await new Promise<void>(resolve=>setTimeout(resolve,delay));
   // Event-loop/scheduler delay consumes the same budget, never another retry window.
   if(performance.now()-started+operationHeadroomMs>budgetMs)throw error;
  }
 }
}
