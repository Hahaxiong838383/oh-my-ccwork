/** Server-only planning quota. Never a device configuration or permission grant. */
export const STORAGE_POLICY_KEY='storage.policy.v1';
export const VERIFIED_PROFILE_KEY='storage.verified-profile.v1';
export type StoragePolicyV1={version:1;revision:number;target_devices:number;beta_admission_limit?:number;archive_enabled:boolean;archive_interval_sec:300;spool_limit_bytes:number;nas_budget_bytes:number};
export type VerifiedProfile={version:1;analytics_devices:number;ark_devices:number;evidence:string;candidate:string;validated_at_ms:number};
const integer=(n:unknown,min:number,max:number):n is number=>Number.isSafeInteger(n)&&Number(n)>=min&&Number(n)<=max;
export function readStoragePolicy(raw:string|null|undefined):StoragePolicyV1{
 if(raw==null)return {version:1,revision:0,target_devices:50,archive_enabled:false,archive_interval_sec:300,spool_limit_bytes:8*1024**3,nas_budget_bytes:1024**4};
 try{const p=JSON.parse(raw);if(p.version!==1||!integer(p.revision,1,Number.MAX_SAFE_INTEGER)||!integer(p.target_devices,1,1000)||(p.beta_admission_limit!==undefined&&!integer(p.beta_admission_limit,0,50))||typeof p.archive_enabled!=='boolean'||p.archive_interval_sec!==300||p.spool_limit_bytes!==8*1024**3||p.nas_budget_bytes!==1024**4)throw 0;return p;}catch{throw new Error('INVALID_STORAGE_POLICY');}
}
export function parseArchiveChange(input:unknown):{expected_revision:number;enabled:boolean}{
 const p=input as Record<string,unknown>;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['expected_revision','enabled'].includes(k))||!integer(p.expected_revision,0,Number.MAX_SAFE_INTEGER-1)||typeof p.enabled!=='boolean')throw new Error('INVALID_ARCHIVE_POLICY');
 return {expected_revision:p.expected_revision,enabled:p.enabled};
}
export function parseStorageChange(input:unknown):{expected_revision:number;target_devices:number}{
 const p=input as Record<string,unknown>;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['expected_revision','target_devices'].includes(k))||!integer(p.expected_revision,0,Number.MAX_SAFE_INTEGER-1)||!integer(p.target_devices,1,1000))throw new Error('INVALID_STORAGE_POLICY');
 return {expected_revision:p.expected_revision,target_devices:p.target_devices};
}
/** Updated only by deployment of an independently reviewed load-test record, not by quota UI. */
export function readVerifiedProfile(raw:string|null|undefined):VerifiedProfile{
 if(raw==null)return {version:1,analytics_devices:14,ark_devices:0,evidence:'ANALYTICS_MEMORY.md:14 synthetic subjects / 84000 events (legacy)',candidate:'legacy-20261031',validated_at_ms:0};
 try{const p=JSON.parse(raw);if(p.version!==1||!integer(p.analytics_devices,0,1000)||!integer(p.ark_devices,0,1000)||typeof p.evidence!=='string'||!p.evidence||p.evidence.length>1000||typeof p.candidate!=='string'||!p.candidate||!integer(p.validated_at_ms,1,Number.MAX_SAFE_INTEGER))throw 0;return p;}catch{throw new Error('INVALID_STORAGE_PROFILE');}
}
export function arkAdmissionLimit(policy:StoragePolicyV1,profile:VerifiedProfile,currentCount:number,legacyLimit=0){
 // Existing grants survive an absent/expired load profile. It authorizes no new expansion.
 return Math.min(policy.target_devices,Math.max(currentCount,legacyLimit,profile.ark_devices,policy.beta_admission_limit??0));
}

/** Original authorized scale survives a deliberate stop/restart, without pretending it was load-tested. */
export function readArkLegacyLimit(raw:string|undefined){
 if(raw===undefined)return 0;
 try{const p=JSON.parse(raw);if(p.version!==1||!integer(p.legacy_limit,0,1000))throw 0;return p.legacy_limit as number;}catch{throw new Error('INVALID_ARK_LEGACY_ALLOWANCE');}
}
