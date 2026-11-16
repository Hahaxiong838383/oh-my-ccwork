import {Hono} from 'hono';
import {decodeJwt} from 'jose';
import {verifyDeviceCredential} from '../device-credential.js';
import {verifyAuthToken} from '../auth-jwt.js';
import {readBoundedJson,ArkHttpError} from './http.js';
import {parseBatch,QuerySchema,RecordsError,limits} from './records-contract.js';
import type {RecordsStore,Credential} from './records-store.js';
type Options={store:()=>RecordsStore;secret:()=>string};
/** This router is mounted on the existing device Ark route, without changing /state. */
export function createRecordsDeviceRoutes(o:Options){
 const app=new Hono();app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 const authenticate=async(header:string|undefined):Promise<Credential>=>{
  const credential=await verifyDeviceCredential(header,o.secret(),(_sn,iat)=>iat>0,sn=>o.store().credentialState(sn));
  if(!credential)throw new RecordsError(401,'invalid_device_credential');
  const payload=decodeJwt(header!.slice(7));return {sn:credential.sn,iat:Number(payload.iat),exp:Number(payload.exp),bindingVersion:credential.bindingVersion};
 };
 app.get('/records/context',async c=>c.json({ok:true,data:o.store().context(await authenticate(c.req.header('authorization')))}));
 app.post('/records:batch',async c=>{
  const credential=await authenticate(c.req.header('authorization'));
  let body:unknown;try{body=await readBoundedJson(c.req.raw,limits().max_batch_bytes);}catch(e){if(e instanceof ArkHttpError)throw new RecordsError(e.status===413?413:e.status===408?503:400,e.status===413?'batch_too_large':e.status===408?'records_dependency_unavailable':'invalid_json');throw e;}
  const b=parseBatch(body),store=o.store();
  // Check all well-formed origins, even for a record whose other fields are invalid.
  // Missing/ill-typed origin is a per-ID schema error; a valid foreign origin denies the whole batch.
  const origins=b.records.map(x=>x.raw).filter(r=>typeof r.origin_grant_id==='string'&&Number.isSafeInteger(r.origin_epoch)).map(r=>({origin_grant_id:r.origin_grant_id,origin_epoch:r.origin_epoch}));
  const identity=store.preflight(credential,origins),accepted_record_ids:string[]=[],duplicated_record_ids:string[]=[],rejected:{record_id:string;reason:string;retryable:boolean}[]=[];
  for(const {raw,parsed} of b.records){
   if(!parsed.success){rejected.push({record_id:raw.record_id,reason:'invalid_record',retryable:false});continue;}
   let result:string;try{result=store.accept(credential,identity,parsed.data);}catch{throw new RecordsError(503,'records_dependency_unavailable');}
   if(result==='accepted')accepted_record_ids.push(raw.record_id);else if(result==='duplicate')duplicated_record_ids.push(raw.record_id);else rejected.push({record_id:raw.record_id,reason:result,retryable:result==='capacity_exceeded'});
  }
  return c.json({ok:true,data:{schema_version:1,batch_id:b.batch_id,accepted_record_ids,duplicated_record_ids,rejected,server_received_ms:Date.now()}});
 });
 app.onError((e,c)=>{const error=e instanceof RecordsError?e:new RecordsError(503,'records_dependency_unavailable');if(error.status===429)c.header('Retry-After','60');if(error.status===403)c.header('Retry-After','900');return c.json({ok:false,error:error.message},error.status);});return app;
}
export function createRecordsParentRoutes(o:Options){
 const app=new Hono();app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 app.get('/:publicId/ark/records',async c=>{
  const auth=await verifyAuthToken(/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')??'')?.[1]);
  if(!auth||auth.role!=='parent')throw new RecordsError(401,'unauthorized');
  const params=new URL(c.req.url).searchParams;
  if([...params.keys()].some(k=>params.getAll(k).length!==1))throw new RecordsError(400,'invalid_query');
  // Ownership is resolved inside page before inspecting/decrypting a cursor.
  const q=QuerySchema.safeParse(Object.fromEntries(params));if(!q.success)throw new RecordsError(400,'invalid_query');
  return c.json({ok:true,data:o.store().page(c.req.param('publicId'),auth.accountId,q.data)});
 });
 app.onError((e,c)=>{const error=e instanceof RecordsError?e:new RecordsError(503,'records_dependency_unavailable');return c.json({ok:false,error:error.message},error.status);});return app;
}
