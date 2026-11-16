import {Hono} from 'hono';
import {readBoundedJson} from '../ark/http.js';
import {parseStorageChange,parseArchiveChange,type StoragePolicyV1,type VerifiedProfile} from './policy.js';
type Options={authorize:(header:string|undefined)=>string;read:()=>{policy:StoragePolicyV1;profile:VerifiedProfile;enabled:{analytics:number;ark:number};ark_capacity:unknown};save:(input:ReturnType<typeof parseStorageChange>)=>StoragePolicyV1;archive?:()=>unknown;saveArchive?:(input:ReturnType<typeof parseArchiveChange>)=>StoragePolicyV1};
export function storageRoute(o:Options){
 const app=new Hono();
 app.use('*',async(c,next)=>{const role=o.authorize(c.req.header('authorization'));if(role!=='admin')return c.json({ok:false,error:role==='none'?'unauthorized':'forbidden'},role==='none'?401:403);c.header('Cache-Control','no-store');await next();});
 app.get('/',c=>c.json({ok:true,...o.read(),archive:o.archive?.()??{state:'unavailable',enabled:false},device_config_changed:false}));
 app.put('/archive',async c=>{
  let p:ReturnType<typeof parseArchiveChange>;try{p=parseArchiveChange(await readBoundedJson(c.req.raw,2048));}catch{return c.json({ok:false,error:'INVALID_ARCHIVE_POLICY'},400);}
  if(!o.saveArchive)return c.json({ok:false,error:'STORAGE_UNAVAILABLE'},503);
  try{return c.json({ok:true,policy:o.saveArchive(p),device_config_changed:false});}
  catch(e){if((e as Error).message==='STORAGE_POLICY_CONFLICT')return c.json({ok:false,error:'STORAGE_POLICY_CONFLICT'},409);throw e;}
 });
 app.put('/',async c=>{
  let p:ReturnType<typeof parseStorageChange>;try{p=parseStorageChange(await readBoundedJson(c.req.raw,2048));}catch{return c.json({ok:false,error:'INVALID_STORAGE_POLICY'},400);}
  try{return c.json({ok:true,policy:o.save(p),device_config_changed:false});}
  catch(e){const error=(e as Error).message;if(['STORAGE_POLICY_CONFLICT','STORAGE_ENABLED_CONFLICT'].includes(error))return c.json({ok:false,error},409);throw e;}
 });
 app.onError((_e,c)=>c.json({ok:false,error:'STORAGE_UNAVAILABLE'},503));return app;
}
