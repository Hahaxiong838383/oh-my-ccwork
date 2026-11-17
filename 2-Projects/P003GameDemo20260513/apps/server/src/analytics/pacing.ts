/** Optional upload admission pacing. No queue, sleeps, payloads or database writes. */
export function createBatchPacer(intervalMs:number,now=()=>performance.now()){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<0||intervalMs>5000)throw new Error('INVALID_ANALYTICS_MIN_BATCH_INTERVAL_MS');
 let next=0;
 const retryAfter=()=>Math.max(0,Math.ceil((next-now())/1000));
 return {retryAfter,acquire(){const wait=retryAfter();if(wait)return wait;next=now()+intervalMs;return 0;}};
}
