import assert from 'node:assert/strict';
/** Test orchestration only: accelerated smoke cannot satisfy the real-day gate. */
export function soakPlan(env:Record<string,string|undefined>,now:number){
 const fullDay=env.T5_SOAK==='1',smoke=env.T5_SOAK_SMOKE==='1',preflight=env.T5_SOAK_PREFLIGHT==='1';
 assert(Number(fullDay)+Number(smoke)+Number(preflight)<=1,'choose one test scope');
 if(!fullDay&&!smoke&&!preflight)return null;
 assert(Number.isSafeInteger(now)&&now>0);
 const day=86400000,cst=8*3600000,localDay=Math.floor((now+cst)/day);
 let dailyAt=localDay*day+23*3600000-cst;if(dailyAt<now)dailyAt+=day;
 return {fullDay,preflight,durationMs:fullDay?day:preflight?600000:17000,dailyDelayMs:fullDay?dailyAt-now:preflight?20000:2000,
  maintenanceIntervalMs:smoke?5000:300000,arkIntervalMs:smoke?2000:50000,monitorIntervalMs:smoke?1000:5000};
}
