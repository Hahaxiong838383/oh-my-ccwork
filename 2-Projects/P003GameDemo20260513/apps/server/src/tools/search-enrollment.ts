import {validCanaryAllowlist} from '../search-canary-policy.js';

export function parseSearchDevices(raw:string|undefined):string[]|null {
 try {
  const value:unknown=JSON.parse(raw??'[]');
  return Array.isArray(value)&&value.length<=4096&&new Set(value).size===value.length
   &&value.every(s=>typeof s==='string'&&/^BJP003\d{14}$/.test(s))?value:null;
 }catch{return null;}
}

/** Enrollment is explicit. Empty lists and invalid configuration never mean all devices. */
export function searchEnrollment(candidate:boolean,scopeRaw:string|undefined,allowRaw:string|undefined,excludeRaw:string|undefined) {
 const scope=scopeRaw??'allowlist',allowed=parseSearchDevices(allowRaw),excluded=parseSearchDevices(excludeRaw);
 const valid=allowed!==null&&excluded!==null&&(scope==='allowlist'||!candidate&&scope==='all_registered')
  &&(!candidate||validCanaryAllowlist(allowed));
 return {scope,scope_valid:valid,allowed:allowed??[],excluded:excluded??[]};
}
