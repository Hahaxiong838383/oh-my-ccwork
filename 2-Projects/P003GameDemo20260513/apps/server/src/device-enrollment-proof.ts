import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BleBindingError, normalizeIdentityPublicKey, parseBleChallengeInput, validBleId, type BleChallengeInput } from './ble-binding-proof.js';
import { fromB64url } from './pairing-crypto.js';
import { validateDeviceSn } from './device-sn.js';

export const ENROLLMENT_PROTOCOL='ble-enroll-v1' as const;
export const ENROLLMENT_PROTOCOL_V2='ble-enroll-v2' as const;
export type EnrollmentProtocol=typeof ENROLLMENT_PROTOCOL|typeof ENROLLMENT_PROTOCOL_V2;
export const ENROLLMENT_TTL_MS=120_000;
export const IDENTITY_LIFETIME_MS=365*86400_000;
export type EnrollmentConfig={enabled:boolean;starts_at_ms:number;expires_at_ms:number;issuer_key_id:string;signing_secret:string;provisioning_token:string};
export type PublicIdentity={sn:string;model:'P003';device_key_id:string;identity_public_key_spki:string};
export type IdentityClaims={v:1;iss:'p003';aud:'p003-ble-enroll-v1';sub:string;kid:string;fp:string;mdl:'P003';jti:string;iat:number;exp:number};
export type EnrollmentInput={input:BleChallengeInput;identity:PublicIdentity;pem:string;fingerprint:string}&(
 {protocol:typeof ENROLLMENT_PROTOCOL;statement:string;claims:IdentityClaims}|
 {protocol:typeof ENROLLMENT_PROTOCOL_V2}
);
const invalid=()=>new BleBindingError(400,'bad_request');
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function exactObject(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value || typeof value!=='object' || Array.isArray(value))throw invalid();
 const row=value as Record<string,unknown>;
 if(Object.keys(row).length!==keys.length || keys.some(k=>!Object.hasOwn(row,k)))throw invalid();
 return row;
}
export function readEnrollmentConfig():EnrollmentConfig{
 try{
  const path=resolve(process.env.DEVICE_ENROLLMENT_CONFIG_PATH?.trim()||'./data/device-enrollment-config.json');
  const stat=statSync(path);if(!stat.isFile()||stat.size>4096||(stat.mode&0o077)!==0)throw new Error();
  const r=exactObject(JSON.parse(readFileSync(path,'utf8')),['enabled','starts_at_ms','expires_at_ms','issuer_key_id','signing_secret','provisioning_token']);
  if(typeof r.enabled!=='boolean'||!Number.isSafeInteger(r.starts_at_ms)||!Number.isSafeInteger(r.expires_at_ms)||Number(r.expires_at_ms)<=Number(r.starts_at_ms)||!validBleId(r.issuer_key_id))throw new Error();
  if(typeof r.signing_secret!=='string'||fromB64url(r.signing_secret)?.length!==32||typeof r.provisioning_token!=='string'||fromB64url(r.provisioning_token)?.length!==32||r.signing_secret===r.provisioning_token)throw new Error();
  return r as EnrollmentConfig;
 }catch{throw new BleBindingError(503,'enrollment_unavailable');}
}
export function assertEnrollmentOpen(config:EnrollmentConfig,now=Date.now()):void{
 if(!config.enabled||now<config.starts_at_ms||now>=config.expires_at_ms)throw new BleBindingError(503,'enrollment_closed');
}
export function provisioningAuthorized(header:string|undefined,config:EnrollmentConfig):boolean{
 const bearer=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(header||'')?.[1];
 return Boolean(bearer&&timingSafeEqual(Buffer.from(digest(bearer)),Buffer.from(digest(config.provisioning_token))));
}
export function parsePublicIdentity(value:unknown):PublicIdentity & {pem:string;fingerprint:string}{
 const r=exactObject(value,['sn','model','device_key_id','identity_public_key_spki']);
 if(!validateDeviceSn(r.sn).ok||r.model!=='P003'||!validBleId(r.device_key_id)||typeof r.identity_public_key_spki!=='string')throw invalid();
 const der=fromB64url(r.identity_public_key_spki);if(!der||der.length!==91)throw invalid();
 try{
  const key=createPublicKey({key:der,type:'spki',format:'der'});
  const normalized=normalizeIdentityPublicKey(key.export({type:'spki',format:'pem'}).toString());
  if(!key.export({type:'spki',format:'der'}).equals(der))throw invalid();
  return {...r as PublicIdentity,...normalized};
 }catch{throw new BleBindingError(400,'invalid_identity_public_key');}
}
export function issueIdentityStatement(identity:ReturnType<typeof parsePublicIdentity>,config:EnrollmentConfig,now=Date.now()){
 const claims:IdentityClaims={v:1,iss:'p003',aud:'p003-ble-enroll-v1',sub:identity.sn,kid:identity.device_key_id,fp:identity.fingerprint,mdl:'P003',jti:randomBytes(18).toString('base64url'),iat:Math.floor(now/1000),exp:Math.floor((now+IDENTITY_LIFETIME_MS)/1000)};
 const header={alg:'HS256',typ:'p003-identity',kid:config.issuer_key_id};
 const signing=Buffer.from(JSON.stringify(header)).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
 return{claims,statement:signing+'.'+createHmac('sha256',Buffer.from(config.signing_secret,'base64url')).update(signing).digest('base64url')};
}
export function verifyIdentityStatement(statement:unknown,identity:ReturnType<typeof parsePublicIdentity>,config:EnrollmentConfig,now=Date.now()):IdentityClaims{
 try{
  if(typeof statement!=='string'||statement.length>1100)throw new Error();
  const parts=statement.split('.');if(parts.length!==3)throw new Error();
  const [h,p,s]=parts.map(fromB64url);if(!h||!p||!s||s.length!==32)throw new Error();
  const expected=createHmac('sha256',Buffer.from(config.signing_secret,'base64url')).update(parts[0]+'.'+parts[1]).digest();
  if(!timingSafeEqual(expected,s))throw new Error();
  const header=exactObject(JSON.parse(h.toString('utf8')),['alg','typ','kid']);
  if(header.alg!=='HS256'||header.typ!=='p003-identity'||header.kid!==config.issuer_key_id)throw new Error();
  const c=exactObject(JSON.parse(p.toString('utf8')),['v','iss','aud','sub','kid','fp','mdl','jti','iat','exp']);
  if(c.v!==1||c.iss!=='p003'||c.aud!=='p003-ble-enroll-v1'||c.mdl!=='P003'||c.sub!==identity.sn||c.kid!==identity.device_key_id||c.fp!==identity.fingerprint||!validBleId(c.jti)||!Number.isSafeInteger(c.iat)||!Number.isSafeInteger(c.exp)||Number(c.iat)<=0||Number(c.iat)*1000>now||Number(c.exp)*1000<=now||Number(c.exp)<=Number(c.iat)||Number(c.exp)-Number(c.iat)>IDENTITY_LIFETIME_MS/1000)throw new Error();
  return c as IdentityClaims;
 }catch{throw new BleBindingError(403,'device_identity_invalid');}
}
export function enrollmentProtocol(value:unknown):EnrollmentProtocol{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
 const p=(value as Record<string,unknown>).binding_protocol;
 if(p!==ENROLLMENT_PROTOCOL&&p!==ENROLLMENT_PROTOCOL_V2)throw invalid();
 return p;
}
export function parseEnrollmentInput(value:unknown,config?:EnrollmentConfig,now=Date.now()):EnrollmentInput{
 const protocol=enrollmentProtocol(value);
 const fields=['binding_protocol','sn','device_key_id','ble_session_id','ble_transcript_hash','pairing_nonce','credential_pk','identity_public_key_spki'];
 const r=exactObject(value,protocol===ENROLLMENT_PROTOCOL?[...fields,'identity_statement']:fields);
 const input=parseBleChallengeInput({binding_protocol:'ble-key-v1',sn:r.sn,device_key_id:r.device_key_id,ble_session_id:r.ble_session_id,ble_transcript_hash:r.ble_transcript_hash,pairing_nonce:r.pairing_nonce,credential_pk:r.credential_pk});
 const identity=parsePublicIdentity({sn:r.sn,model:'P003',device_key_id:r.device_key_id,identity_public_key_spki:r.identity_public_key_spki});
 if(protocol===ENROLLMENT_PROTOCOL_V2){
  if(identity.device_key_id!=='p003_'+identity.fingerprint.slice(0,48))throw new BleBindingError(400,'invalid_identity_public_key');
  return{protocol,input,identity,pem:identity.pem,fingerprint:identity.fingerprint};
 }
 const claims=verifyIdentityStatement(r.identity_statement,identity,config??readEnrollmentConfig(),now);
 return{protocol,input,identity,pem:identity.pem,fingerprint:identity.fingerprint,statement:r.identity_statement as string,claims};
}
export function enrollmentSigningPayload(accountId:string,value:EnrollmentInput,challengeId:string,nonce:string,expiresAt:number):string{
 if(!validBleId(accountId)||!validBleId(challengeId)||fromB64url(nonce)?.length!==32||!Number.isSafeInteger(expiresAt))throw invalid();
 const i=value.input;
 const v1=value.protocol===ENROLLMENT_PROTOCOL;
 return Buffer.from([v1?'P003-BLE-ENROLL-V1':'P003-BLE-ENROLL-V2','kidshub-ai.hahaxiong.cc',challengeId,nonce,accountId,i.sn,i.device_key_id,value.fingerprint,...(v1?[digest(value.statement)]:[]),i.ble_session_id,i.ble_transcript_hash,i.credential_pk,i.pairing_nonce,String(expiresAt)].join('\n'),'ascii').toString('base64url');
}
