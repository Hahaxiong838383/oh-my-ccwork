import { Hono, type Context } from 'hono';
import { decodeJwt } from 'jose';
import { verifyDeviceCredential, isDeviceCredentialBindingAllowed } from '../device-credential.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { ArkHttpError, readBoundedJson } from '../ark/http.js';
import { dashboardArk } from '../ark/dashboard.js';
import { recordsStore } from '../ark/records-service.js';
import { taskScopeForDevice, TaskError, type TaskScope } from '../parent-tasks/scope.js';
import { taskStore } from '../parent-tasks/store.js';
import { syncSchema, batchSchema, DeviceTaskError, deviceTaskReceipts, deviceTaskSync, installDeviceTaskSchema } from '../parent-tasks/device.js';

async function requestContext(c:Context){
  const header=c.req.header('authorization');
  const credential=await verifyDeviceCredential(header,process.env.AUTH_JWT_SECRET??'',(_sn,iat)=>iat>0);
  if(!credential)throw new DeviceTaskError(401,'unauthorized',header?'invalid_device_credential':'credential_missing');
  const {iat,exp}=decodeJwt(header!.slice(7));
  const body=await readBoundedJson(c.req.raw,64*1024);
  if(!body||typeof body!=='object'||!('contract_version' in body))throw new DeviceTaskError(400,'bad_request','contract_version_required');
  if(body.contract_version!=='1.0')throw new DeviceTaskError(426,'upgrade_required','unsupported_contract_version');
  function scope(){
    const current=taskScopeForDevice(credential!.sn);
    const epoch=deviceRegistryStore.credentialNotBeforeSec(credential!.sn), now=Math.floor(Date.now()/1000);
    if(!Number.isSafeInteger(iat)||!Number.isSafeInteger(exp)||iat!>now||exp!<=now||exp!<=iat!||(epoch!==null&&iat!<=epoch)
      ||!isDeviceCredentialBindingAllowed(deviceRegistryStore.credentialBindingState(credential!.sn),credential!.bindingVersion))
      throw new DeviceTaskError(401,'unauthorized','invalid_device_credential');
    if(!current)throw new DeviceTaskError(403,'forbidden','bound_device_required');
    if(credential!.bindingVersion===undefined){
      // A generation-less credential must provably postdate the current binding. Its JWT
      // clock has second precision, so the entire second of a registry edit is ambiguous.
      const device=deviceRegistryStore.get(current.sn);
      if(!device||!Number.isSafeInteger(device.updated_at)||iat!*1000<=device.updated_at)
        throw new DeviceTaskError(401,'unauthorized','binding_credential_refresh_required');
    }
    return current;
  }
  return {body,scope};
}

function run<T>(readScope:()=>TaskScope,fn:(store:ReturnType<typeof taskStore>,scope:TaskScope)=>T){
  const store=taskStore();
  installDeviceTaskSchema(store.db);
  return store.transaction(()=>{
    const scope=readScope(), result=fn(store,scope);
    if(readScope().key!==scope.key)throw new DeviceTaskError(409,'identity_conflict','binding_version_mismatch');
    return result;
  });
}
export const deviceParentTasksRoute=new Hono();
deviceParentTasksRoute.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
deviceParentTasksRoute.post('/sync',async c=>{
  const req=await requestContext(c), parsed=syncSchema.safeParse(req.body);
  if(!parsed.success)throw new DeviceTaskError(400,'bad_request','invalid_sync_request');
  const data=run(req.scope,(store,scope)=>{
    const trusted=parsed.data.source_mode==='normal'&&dashboardArk(scope.sn).available
      &&recordsStore().trustedTaskSave(scope.sn,scope.owner,parsed.data.save_id);
    return deviceTaskSync(store,scope,parsed.data,trusted,Date.now());
  });
  return c.json({ok:true,data});
});
deviceParentTasksRoute.post('/receipts:batch',async c=>{
  const req=await requestContext(c),parsed=batchSchema.safeParse(req.body);
  if(!parsed.success)throw new DeviceTaskError(400,'bad_request','invalid_receipts_batch');
  const data=run(req.scope,(store,scope)=>deviceTaskReceipts(store,scope,parsed.data.receipts,Date.now()));
  return c.json({ok:true,data});
});
deviceParentTasksRoute.onError((error,c)=>{
  if(error instanceof DeviceTaskError||error instanceof TaskError)return c.json({ok:false,error:error.code,reason:error.reason},error.status);
  if(error instanceof ArkHttpError&&error.status!==408)return c.json({ok:false,error:'bad_request',reason:error.message},error.status);
  c.header('Retry-After','5');return c.json({ok:false,error:'service_unavailable',reason:'retry_later'},503);
});
