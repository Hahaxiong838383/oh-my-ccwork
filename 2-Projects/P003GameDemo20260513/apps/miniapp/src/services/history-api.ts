import {ApiError,apiRequest} from './api';
import type {HistoryPage,HistoryQuery} from './live-history';
import { observation, type Observation } from './observations';
import { businessItem, type BusinessItem } from './business-record';
export type { BusinessItem } from './business-record';
export type ConversationItem={id:string;role:'user'|'assistant';text:string;ts:number};
const object=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new ApiError(502,{error:'invalid_history'});return v as Record<string,any>;};
function params(q:HistoryQuery){const values:Record<string,string>={limit:String(q.limit)};if(q.cursor)values.cursor=q.cursor;if(q.fromDay)values.from_day=q.fromDay;if(q.toDay)values.to_day=q.toDay;if(q.kind)values.kind=q.kind;return Object.entries(values).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');}
async function getPage(publicId:string,kind:string,q:HistoryQuery){const result=object(await apiRequest(`/v1/parent/devices/${encodeURIComponent(publicId)}/${kind}?${params(q)}`));const d=object(result.data);if(result.ok!==true||d.schemaVersion!==1||!Array.isArray(d.items)||typeof d.hasMore!=='boolean'||!(d.nextCursor===null||typeof d.nextCursor==='string')||(d.hasMore&&!d.nextCursor))throw new ApiError(502,{error:'invalid_history'});return d;}
export async function getConversationPage(publicId:string,q:HistoryQuery):Promise<HistoryPage<ConversationItem>>{
 const d=await getPage(publicId,'conversations',q);const items=d.items.map((v:unknown)=>{const r=object(v);if(typeof r.id!=='string'||!['user','assistant'].includes(r.role)||typeof r.text!=='string'||typeof r.ts!=='number'||!Number.isFinite(r.ts))throw new ApiError(502,{error:'invalid_conversation'});return {id:r.id,role:r.role,text:r.text,ts:r.ts} as ConversationItem;});
 for(const k of ['messageCount','userMessageCount','assistantMessageCount'])if(!Number.isSafeInteger(d[k])||d[k]<0)throw new ApiError(502,{error:'invalid_history_count'});return {items,nextCursor:d.nextCursor,hasMore:d.hasMore,messageCount:d.messageCount,userMessageCount:d.userMessageCount,assistantMessageCount:d.assistantMessageCount,historyComplete:false};
}
export async function getBusinessPage(publicId:string,q:HistoryQuery):Promise<HistoryPage<BusinessItem>>{
 const d=await getPage(publicId,'ark/records',q);return {items:d.items.map(businessItem),nextCursor:d.nextCursor,hasMore:d.hasMore,historyComplete:false};
}
export async function getObservationPage(publicId:string,q:HistoryQuery):Promise<HistoryPage<Observation>>{
 const d=await getPage(publicId,'observations',q);return {items:d.items.map(observation),nextCursor:d.nextCursor,hasMore:d.hasMore,historyComplete:false};
}
