import {resolve} from 'node:path';import {readBoundedJson} from './ark/http.js';import {parentHistoryScope,assertHistoryScope,readOnlyDatabase} from './history-scope.js';
import {ObservationQuerySchema,ObservationError,emptyObservations,type ObservationQuery, type readObservationData} from './history-observations.js';import {readUsageEvents,buildHistoricalUsage,type UsageEvent} from './history-usage.js';
type Bundle=ReturnType<typeof readObservationData>;
export function observationQuery(params:URLSearchParams):ObservationQuery{if([...params.keys()].some(k=>params.getAll(k).length!==1))throw new ObservationError(400,'invalid_query');const p=ObservationQuerySchema.safeParse(Object.fromEntries(params));if(!p.success)throw new ObservationError(400,'invalid_query');return p.data;}
export async function parentObservationBundle(publicId:string,owner:string,role:string,query:ObservationQuery={}){
 const scope=parentHistoryScope(publicId,owner,role),controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),2000);
 try{const base=process.env.ANALYTICS_INTERNAL_URL??process.env.ARK_ANALYTICS_INTERNAL_URL??'http://127.0.0.1:3006',url=new URL('/internal/analytics/parent-observations',base);if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new ObservationError(503,'observations_dependency_unavailable');
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Analytics-Internal-Token':process.env.ANALYTICS_INTERNAL_SECRET??''},body:JSON.stringify({scope,query}),signal:controller.signal});
  if(!response.ok)throw new ObservationError(([400,404,410].includes(response.status)?response.status:503) as 400|404|410|503,response.status===410?'cursor_expired':response.status===400?'invalid_cursor':response.status===404?'not_found':'observations_dependency_unavailable');
  const raw=await readBoundedJson(response,2*1024*1024,1500,controller.signal) as {ok?:boolean;data?:Bundle};if(raw.ok!==true||!raw.data||!raw.data.summary||!Array.isArray(raw.data.progress)||!raw.data.page||!Array.isArray(raw.data.page.items))throw new ObservationError(503,'observations_dependency_unavailable');assertHistoryScope(scope);return {scope,bundle:raw.data};
 }catch(e){if(e instanceof ObservationError)throw e;throw new ObservationError(503,'observations_dependency_unavailable');}finally{clearTimeout(timeout);}
}
export async function readParentObservations(publicId:string,owner:string,role:string,params:URLSearchParams){const {bundle}=await parentObservationBundle(publicId,owner,role,observationQuery(params));return {ok:true,data:bundle.page};}
export async function readParentHistoricalData(publicId:string,owner:string,role:string,now=Date.now()){
 const scope=parentHistoryScope(publicId,owner,role);let events:UsageEvent[]=[],telemetryAvailable=true;
 try{const db=readOnlyDatabase(resolve(process.env.TELEMETRY_DB_PATH??'./data/telemetry.db'));try{events=readUsageEvents(db,scope.sn);}finally{db.close();}}catch{telemetryAvailable=false;}
 let observations=emptyObservations('dependency_unavailable'),progress:Bundle['progress']=[],analyticsAvailable=true;
 try{const result=await parentObservationBundle(publicId,owner,role);observations=result.bundle.summary;progress=result.bundle.progress;}
 catch(e){assertHistoryScope(scope);if(e instanceof ObservationError&&e.status!==503)throw e;analyticsAvailable=false;}
 const usage=buildHistoricalUsage(events,progress,now),historical_usage={...usage,reason:!telemetryAvailable&&!analyticsAvailable?'dependency_unavailable':usage.reason,coverage:{...usage.coverage,telemetry_available:telemetryAvailable,analytics_available:analyticsAvailable}};assertHistoryScope(scope);return {observations,historical_usage};
}
