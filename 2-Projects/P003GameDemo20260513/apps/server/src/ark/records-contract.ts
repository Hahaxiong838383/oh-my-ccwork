import {z} from 'zod';
export const CONTRACT='p003.ark.records.r1';
const id=z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);
const safe=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const seq=safe.min(1), time=seq.max(8e12), count=safe.max(1e9);
export const OriginSchema=z.object({origin_grant_id:z.string().uuid(),origin_epoch:seq});
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===s;});
const resourceId=z.enum(['family_coin','stardust','M-CARD-001']);
const resource=z.object({resource_id:resourceId,delta:z.number().int().min(-1e9).max(1e9).refine(n=>n!==0),before:count.nullable(),after:count.nullable()}).strict().superRefine((v,c)=>{if(v.before!==null&&v.after!==null&&v.after-v.before!==v.delta)c.addIssue({code:'custom',message:'balance_delta_mismatch'});});
const item=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('acquired'),item_instance_id:id,item_id:id,item_kind:z.enum(['tank_component','avatar_decoration','unknown']),quantity:count.min(1),state:z.enum(['pending_activation','active','unknown'])}).strict(),
 z.object({operation:z.literal('activated'),item_instance_id:id,acquired_record_id:id,state:z.literal('active')}).strict()
]);
export const RecordSchema=z.object({record_id:id,save_id:id,sequence:seq,origin_grant_id:z.string().uuid(),origin_epoch:seq,occurred_at_ms:time.nullable(),time_quality:z.enum(['reported','unknown']),logical_day:day.nullable(),source_mode:z.enum(['normal','gm','unknown']),reason:z.enum(['reward_claim','tank_unlock','makeup_card_use','resource_spend','item_activation','gm_adjustment','unknown']),business_source_id:id.nullable(),tank_id:id.nullable(),stage_id:id.nullable(),resource_changes:z.array(resource).max(3),item_changes:z.array(item).max(32)}).strict().superRefine((r,c)=>{
 const bad=(m:string)=>c.addIssue({code:'custom',message:m});
 if((r.time_quality==='unknown')!==(r.occurred_at_ms===null))bad('time_quality_mismatch');
 if(!r.resource_changes.length&&!r.item_changes.length)bad('empty_transaction');
 if(new Set(r.resource_changes.map(x=>x.resource_id)).size!==r.resource_changes.length)bad('duplicate_resource');
 if(new Set(r.item_changes.map(x=>x.item_instance_id)).size!==r.item_changes.length)bad('duplicate_item_instance');
 if(!['unknown','gm_adjustment'].includes(r.reason)&&r.business_source_id===null)bad('business_source_required');
 if(['reward_claim','tank_unlock'].includes(r.reason)&&(r.resource_changes.some(x=>x.delta<0)||r.item_changes.some(x=>x.operation!=='acquired')))bad('reward_direction');
 if(r.reason==='makeup_card_use'&&(r.item_changes.length||r.resource_changes.length!==1||r.resource_changes[0].resource_id!=='M-CARD-001'||r.resource_changes[0].delta>=0))bad('invalid_makeup_use');
 if(r.reason==='resource_spend'&&(!r.resource_changes.length||r.resource_changes.some(x=>x.resource_id==='M-CARD-001'||x.delta>=0)||r.item_changes.some(x=>x.operation!=='acquired')))bad('invalid_spend');
 if(r.reason==='item_activation'&&(r.resource_changes.length||!r.item_changes.length||r.item_changes.some(x=>x.operation!=='activated')))bad('invalid_activation');
 if(r.reason==='gm_adjustment'&&r.source_mode!=='gm')bad('gm_source_required');
 if(r.item_changes.some(x=>x.operation==='activated'&&x.acquired_record_id===r.record_id))bad('self_acquisition_reference');
});
export const QuerySchema=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().min(1).max(2048).optional(),save_id:z.string().min(1).max(96).regex(/^[A-Za-z0-9_.:-]+$/).optional(),resource_id:resourceId.optional(),from_day:day.optional(),to_day:day.optional()}).strict().refine(q=>!q.from_day||!q.to_day||q.from_day<=q.to_day,'invalid_day_range');

export type BusinessRecord=z.infer<typeof RecordSchema>;
export type RecordQuery=z.infer<typeof QuerySchema>;
export function canonical(v:unknown):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v!==null&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';return JSON.stringify(v);}

export class RecordsError extends Error {constructor(public status:400|401|403|404|410|413|429|503,code:string){super(code);}}
export function limits(){
 const n=(name:string,fallback:number)=>{const raw=process.env['ARK_RECORDS_'+name];if(raw===undefined)return fallback;if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new RecordsError(503,'records_configuration_invalid');return Number(raw);};
 return {max_records:50,max_batch_bytes:262144,max_record_bytes:32768,
 upload_per_minute:n('UPLOAD_PER_MINUTE',6),upload_per_hour:n('UPLOAD_PER_HOUR',120),context_per_minute:n('CONTEXT_PER_MINUTE',6),
 global_upload_per_minute:n('GLOBAL_UPLOAD_PER_MINUTE',12),global_upload_per_hour:n('GLOBAL_UPLOAD_PER_HOUR',240),
 per_sn_records:n('PER_SN_RECORDS',10000),per_sn_payload_bytes:n('PER_SN_PAYLOAD_BYTES',33554432),global_records:n('GLOBAL_RECORDS',10000),global_payload_bytes:n('GLOBAL_PAYLOAD_BYTES',33554432),
 min_free_disk_bytes:n('MIN_FREE_BYTES',8589934592),cursor_ttl_ms:n('CURSOR_TTL_MS',1800000),future_clock_tolerance_ms:n('FUTURE_CLOCK_TOLERANCE_MS',300000)};
}
export function parseBatch(v:unknown){
 if(v&&typeof v==='object'&&Array.isArray((v as any).records)&&(v as any).records.length>50)throw new RecordsError(413,'batch_too_large');
 const e=z.object({schema_version:z.literal(1),batch_id:id,records:z.array(z.object({record_id:id}).passthrough()).min(1).max(50)}).strict().safeParse(v);
 if(!e.success)throw new RecordsError(400,'invalid_envelope');
 if(new Set(e.data.records.map(r=>r.record_id)).size!==e.data.records.length)throw new RecordsError(400,'duplicate_record_id_in_batch');
 // Bound before recursive canonicalization: untrusted extras can contain extremely deep JSON.
 if(e.data.records.some(r=>Buffer.byteLength(JSON.stringify(r))>32768))throw new RecordsError(413,'record_too_large');
 return {batch_id:e.data.batch_id,records:e.data.records.map(raw=>({raw,parsed:RecordSchema.safeParse(raw)}))};
}
export const emptyCoverage=()=>({kind:'received_records' as const,complete:false as const,reason:'partial_history' as const,min_occurred_at_ms:null as number|null,max_occurred_at_ms:null as number|null,first_received_at_ms:null as number|null,last_received_at_ms:null as number|null});
export type SummaryItem={item_instance_id:string;item_id:string;item_kind:'tank_component'|'avatar_decoration'|'unknown';quantity:number;state:'pending_activation'|'active'|'unknown';activation_record_id:string|null};
export function dashboardRecords(coverage=emptyCoverage(),reason='no_records',now=Date.now()){
 return {schema_version:1,coverage,updated_at_ms:coverage.last_received_at_ms,
 recent_activity:{schema_version:1,source:'ark_records' as const,available:false,reason,limit:20,items:[] as unknown[],next_cursor:null as string|null,has_more:false,coverage,updated_at_ms:coverage.last_received_at_ms},
 yesterday_income:{available:false,reason,date:new Date(now+8*3600000-86400000).toISOString().slice(0,10),timezone:'Asia/Shanghai',source_mode:null as 'normal'|null,family_coin:null as number|null,stardust:null as number|null,occurred_from_ms:null as number|null,occurred_to_ms:null as number|null,received_at_ms:null as number|null},
 latest_items:{available:false,reason,source_mode:null as 'normal'|null,record_id:null as string|null,save_id:null as string|null,occurred_at_ms:null as number|null,received_at_ms:null as number|null,items:[] as SummaryItem[]}};
}
