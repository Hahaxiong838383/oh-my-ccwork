import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { accountStore } from '../account-store.js';
import { verifyAuthToken } from '../auth-jwt.js';
import { BleBindingError } from '../ble-binding-proof.js';
import { ENROLLMENT_PROTOCOL, ENROLLMENT_PROTOCOL_V2, assertEnrollmentOpen, exactObject, provisioningAuthorized, readEnrollmentConfig } from '../device-enrollment-proof.js';
import { getDeviceEnrollmentStore } from '../device-enrollment-store.js';
import { initializeBrain, receipt } from './ble-bindings.js';

const messages:Record<string,string>={unauthorized:'请先登录',bad_request:'请求格式不正确',invalid_identity_public_key:'设备身份格式不正确',device_identity_invalid:'设备身份材料未通过验证，请联系设备维护人员',device_proof_invalid:'设备确认失败，请重新连接',device_not_available:'设备当前不可接入，请联系设备维护人员',identity_key_conflict:'设备身份已存在，不能覆盖',device_already_bound:'该设备已绑定其他账号',binding_changed:'设备状态已变化，请重新连接',binding_not_found:'未找到本次绑定请求',challenge_expired:'设备确认已超时，请重新连接',enrollment_unavailable:'设备接入服务暂不可用',enrollment_closed:'当前未开放新设备接入',rate_limited:'操作频繁，请稍后重试'};
function failure(c:Context,error:unknown){
 const known=error instanceof BleBindingError;const code=known?error.error:'enrollment_unavailable';const status=known?error.status:503;
 const rid=c.get('requestId')||randomUUID();
 // Never log input, bearer, certificates, nonces, public/private key bodies or signatures.
 console.warn(`[device-enrollment] rejected request_id=${rid} stage=${c.get('stage')||'auth'} reason=${known?code:'internal_unavailable'} status=${status}`);
 if(status===429)c.header('Retry-After','60');
 return c.json({ok:false,error:code,message:messages[code]||messages.enrollment_unavailable,request_id:rid},status as 400);
}
const buckets=new Map<string,{until:number;n:number}>();
function limited(key:string,max:number){
 const now=Date.now();if(buckets.size>=4096)for(const[k,v]of buckets)if(v.until<=now)buckets.delete(k);
 let e=buckets.get(key);if(!e||e.until<=now){if(!e&&buckets.size>=8192)return true;e={until:now+60_000,n:0};buckets.set(key,e);}return ++e.n>max;
}
function init(c:Context,stage:string){c.set('requestId',randomUUID());c.set('stage',stage);c.header('Cache-Control','no-store');}
export const deviceProvisioningRoute=new Hono<{Variables:{requestId:string;stage:string}}>();
deviceProvisioningRoute.use('*',async(c,next)=>{init(c,'issue');await next();});
deviceProvisioningRoute.use('*',bodyLimit({maxSize:4096,onError:c=>failure(c,new BleBindingError(400,'bad_request'))}));
deviceProvisioningRoute.post('/identity',async c=>{
 try{
  const config=readEnrollmentConfig();
  if(!provisioningAuthorized(c.req.header('authorization'),config))throw new BleBindingError(401,'unauthorized');
  assertEnrollmentOpen(config);
  if(limited('provisioning:'+config.issuer_key_id,60))throw new BleBindingError(429,'rate_limited');
  const result=getDeviceEnrollmentStore().issue(await c.req.json().catch(()=>null),config);
  console.log(`[device-enrollment] issued request_id=${c.get('requestId')} idempotent=${result.idempotent}`);
  return c.json({ok:true,...result,binding_protocol:ENROLLMENT_PROTOCOL,request_id:c.get('requestId')});
 }catch(e){return failure(c,e);}
});

export const deviceEnrollmentRoute=new Hono<{Variables:{accountId:string;requestId:string;stage:string}}>();
deviceEnrollmentRoute.use('*',async(c,next)=>{
 init(c,'auth');
 try{
  const secret=process.env.AUTH_JWT_SECRET||'';
  if(secret!==secret.trim()||Buffer.byteLength(secret)<32)throw new BleBindingError(503,'enrollment_unavailable');
  const token=/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim()||'')?.[1];
  const auth=await verifyAuthToken(token);
  if(!auth||auth.role!=='parent'||accountStore.findAccount(auth.accountId)?.role!=='parent')throw new BleBindingError(401,'unauthorized');
  c.set('accountId',auth.accountId);
  if(limited('parent:'+auth.accountId,90))throw new BleBindingError(429,'rate_limited');
  await next();
 }catch(e){return failure(c,e);}
});
deviceEnrollmentRoute.use('*',bodyLimit({maxSize:8192,onError:c=>failure(c,new BleBindingError(400,'bad_request'))}));
deviceEnrollmentRoute.get('/capabilities',c=>{
 try{
  const requested=c.req.query('binding_protocol');
  if(requested===ENROLLMENT_PROTOCOL){
   const config=readEnrollmentConfig();return c.json({ok:true,binding_protocol:ENROLLMENT_PROTOCOL,enabled:config.enabled&&Date.now()>=config.starts_at_ms&&Date.now()<config.expires_at_ms,identity_statement_required:true,window_starts_at_ms:config.starts_at_ms,window_expires_at_ms:config.expires_at_ms,challenge_ttl_s:120,request_id:c.get('requestId')});
  }
  if(requested&&requested!==ENROLLMENT_PROTOCOL_V2)throw new BleBindingError(400,'bad_request');
  return c.json({ok:true,binding_protocol:ENROLLMENT_PROTOCOL_V2,supported_protocols:[ENROLLMENT_PROTOCOL_V2,ENROLLMENT_PROTOCOL],enabled:true,identity_statement_required:false,window_starts_at_ms:null,window_expires_at_ms:null,challenge_ttl_s:120,claim_protocol:'ble-key-v1',request_id:c.get('requestId')});
 }catch(e){return failure(c,e);}
});
deviceEnrollmentRoute.post('/challenge',async c=>{
 c.set('stage','challenge');
 try{
  if(limited('challenge:'+c.get('accountId'),12))throw new BleBindingError(429,'rate_limited');
  const result=getDeviceEnrollmentStore().prepare(c.get('accountId'),await c.req.json().catch(()=>null));
  console.log(`[device-enrollment] challenge request_id=${c.get('requestId')} challenge_id=${result.challenge_id}`);
  return c.json({ok:true,...result,request_id:c.get('requestId')});
 }catch(e){return failure(c,e);}
});
deviceEnrollmentRoute.post('/confirm',async c=>{
 c.set('stage','confirm');
 try{
  const input=exactObject(await c.req.json().catch(()=>null),['challenge_id','device_signature']);
  if(typeof input.challenge_id!=='string'||typeof input.device_signature!=='string')throw new BleBindingError(400,'bad_request');
  const row=getDeviceEnrollmentStore().confirm(c.get('accountId'),input.challenge_id,input.device_signature);
  const initialized=initializeBrain(c.get('accountId'),row);
  console.log(`[device-enrollment] bound request_id=${c.get('requestId')} binding_id=${row.binding_id} already_bound=${row.already_bound}`);
  return c.json({ok:true,...receipt(initialized,row.already_bound),enrollment_protocol:row.enrollment_protocol,claim_protocol:'ble-key-v1',request_id:c.get('requestId')});
 }catch(e){return failure(c,e);}
});
