import assert from 'node:assert/strict';
/** Test orchestration only: accelerated smoke cannot satisfy the real-day gate. */
export function soakPlan(env:Record<string,string|undefined>,now:number){
 const fullDay=env.T5_SOAK==='1',smoke=env.T5_SOAK_SMOKE==='1';
 assert(!(fullDay&&smoke),'choose real day or explicitly labelled smoke');
 if(!fullDay&&!smoke)return null;
 assert(Number.isSafeInteger(now)&&now>0);
 const day=86400000,cst=8*3600000,localDay=Math.floor((now+cst)/day);
 let dailyAt=localDay*day+23*3600000-cst;if(dailyAt<now)dailyAt+=day;
 return {fullDay,durationMs:fullDay?day:17000,dailyDelayMs:fullDay?dailyAt-now:2000,
  maintenanceIntervalMs:fullDay?300000:5000,arkIntervalMs:fullDay?50000:2000,monitorIntervalMs:fullDay?5000:1000};
}
