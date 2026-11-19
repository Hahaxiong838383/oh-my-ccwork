import {Hono} from 'hono';import {createHash,timingSafeEqual} from 'node:crypto';import type {DatabaseSync} from 'node:sqlite';import {z} from 'zod';
import {readBoundedJson} from '../ark/http.js';import {HistoryScopeSchema,assertHistoryScope} from '../history-scope.js';import {readObservationData,ObservationQuerySchema,ObservationError} from '../history-observations.js';
export function createObservationGateway(o:{db:DatabaseSync;deviceKey:(sn:string)=>string;internalSecret:string;cursorSecret:string}){
 const app=new Hono(),schema=z.object({scope:HistoryScopeSchema,query:ObservationQuerySchema}).strict();
 app.post('/internal/analytics/parent-observations',async c=>{c.header('Cache-Control','no-store');const token=c.req.header('X-Analytics-Internal-Token'),hash=(s:string)=>createHash('sha256').update(s).digest();if(!o.internalSecret||!token||!timingSafeEqual(hash(token),hash(o.internalSecret)))return c.json({ok:false,error:'unauthorized'},401);
  try{const parsed=schema.safeParse(await readBoundedJson(c.req.raw,8192));if(!parsed.success)return c.json({ok:false,error:'invalid_query'},400);const {scope,query}=parsed.data;assertHistoryScope(scope);const result=readObservationData(o.db,o.deviceKey(scope.sn),query,JSON.stringify(scope),o.cursorSecret);assertHistoryScope(scope);return c.json({ok:true,data:result});}
  catch(e){if(e instanceof ObservationError)return c.json({ok:false,error:e.message},e.status);return c.json({ok:false,error:'observations_dependency_unavailable'},503);}
 });return app;
}
