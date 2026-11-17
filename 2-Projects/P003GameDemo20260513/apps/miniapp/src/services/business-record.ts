import { ApiError } from './api-error';

export type BusinessItem = {
 recordId:string;saveId:string;sequence:number;sourceMode:string;reason:string;logicalDay?:string|null;
 occurredAtMs:number|null;receivedAtMs:number;timeStatus:string;
 resourceChanges:{resourceId:string;delta:number}[];
 itemChanges:{operation:string;itemInstanceId:string;itemId?:string;quantity?:number;state:string}[];
 format?:string;recordKind?:'baseline'|'business_commit';authorizationSource?:string;originVerified?:boolean;
 baseline?:{wallets:{familyCoin:number|null;stardust:number|null;'M-CARD-001':number|null};items:{itemId:string;quantity:number|null;state:string;itemKind?:string}[]};
 inventoryStateChanges?:{itemId:string;fromState:string;toState:string;quantity:number|null}[];
 grants?:{rewardInstanceId:string;sourceKind:string;sourceId:string;logicalDay:string;resolvedRewards:{itemId:string;kind:string;quantity:number}[]}[];
 inventoryChanges?:{itemId:string;before:{quantity:number;status:string}|null;after:{quantity:number;status:string}|null}[];
 makeupGrants?:{tankId:string}[];
 makeupUses?:{tankId:string|null;logicalDay:string;usageDayIndex:number}[];
};

/** Same read shape is used by dashboard previews and the existing paged records API. */
export function businessItem(value:unknown):BusinessItem {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(502,{error:'invalid_record'});
 const r=value as Record<string,unknown>;
 if(typeof r.recordId!=='string'||typeof r.saveId!=='string'||!Number.isSafeInteger(r.sequence)||!Array.isArray(r.resourceChanges)||!Array.isArray(r.itemChanges))throw new ApiError(502,{error:'invalid_record'});
 return r as BusinessItem;
}
