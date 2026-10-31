import {validateDeviceSn} from '../device-sn.js';

export const UPLOAD_POLICY_KEY='analytics.upload_policy.v1';
export type UploadPolicy={version:1;revision:number;enabled:boolean;subjects:string[];hour:number;updated_at_ms:number};
export function parseUploadPolicy(text:string):UploadPolicy{
  const p=JSON.parse(text);
  if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['version','revision','enabled','subjects','hour','updated_at_ms'].includes(k))||p.version!==1||!Number.isSafeInteger(p.revision)||p.revision<1||typeof p.enabled!=='boolean'||!Array.isArray(p.subjects)||p.subjects.length>1000||p.subjects.some((s:unknown)=>typeof s!=='string'||!validateDeviceSn(s).ok)||new Set(p.subjects).size!==p.subjects.length||!Number.isInteger(p.hour)||p.hour<0||p.hour>23||!Number.isSafeInteger(p.updated_at_ms))throw new Error('ANALYTICS_POLICY_INVALID');
  return p;
}
export function parseUploadChange(p:unknown):{expected_revision:number;enabled:boolean;subjects:string[];hour:number}{
  if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('INVALID_POLICY');
  const b=p as Record<string,unknown>;
  if(Object.keys(b).some(k=>!['expected_revision','enabled','subjects','hour'].includes(k))||!Number.isSafeInteger(b.expected_revision)||Number(b.expected_revision)<0)throw new Error('INVALID_POLICY');
  try{parseUploadPolicy(JSON.stringify({version:1,revision:1,enabled:b.enabled,subjects:b.subjects,hour:b.hour,updated_at_ms:0}));}catch{throw new Error('INVALID_POLICY');}
  return b as ReturnType<typeof parseUploadChange>;
}
