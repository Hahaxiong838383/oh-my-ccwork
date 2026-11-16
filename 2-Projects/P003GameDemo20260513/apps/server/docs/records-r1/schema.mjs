// R1 contract validation only; this module does not implement or call production APIs.
import {z} from 'zod';
export const CONTRACT='p003.ark.records.r1';
export const LIMITS={max_records:50,max_batch_bytes:262144,max_record_bytes:32768,upload_per_minute:6,upload_per_hour:120,context_per_minute:6,global_upload_per_minute:12,global_upload_per_hour:240,per_sn_records:10000,per_sn_payload_bytes:33554432,global_records:10000,global_payload_bytes:33554432,min_free_disk_bytes:8589934592,cursor_ttl_ms:1800000,future_clock_tolerance_ms:300000};
const id=z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/);
const safe=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const seq=safe.min(1), time=seq.max(8e12), count=safe.max(1e9);
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===s;});
const resourceId=z.enum(['family_coin','stardust','M-CARD-001']);
const resource=z.object({resource_id:resourceId,delta:z.number().int().min(-1e9).max(1e9).refine(n=>n!==0),before:count.nullable(),after:count.nullable()}).strict().superRefine((v,c)=>{if(v.before!==null&&v.after!==null&&v.after-v.before!==v.delta)c.addIssue({code:'custom',message:'balance_delta_mismatch'});});
const item=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('acquired'),item_instance_id:id,item_id:id,item_kind:z.enum(['tank_component','avatar_decoration','unknown']),quantity:count.min(1),state:z.enum(['pending_activation','active','unknown'])}).strict(),
 z.object({operation:z.literal('activated'),item_instance_id:id,acquired_record_id:id,state:z.literal('active')}).strict()
]);
export const RecordSchema=z.object({record_id:id,save_id:id,sequence:seq,origin_grant_id:z.string().uuid(),origin_epoch:seq,occurred_at_ms:time.nullable(),time_quality:z.enum(['reported','unknown']),logical_day:day.nullable(),source_mode:z.enum(['normal','gm','unknown']),reason:z.enum(['reward_claim','tank_unlock','makeup_card_use','resource_spend','item_activation','gm_adjustment','unknown']),business_source_id:id.nullable(),tank_id:id.nullable(),stage_id:id.nullable(),resource_changes:z.array(resource).max(3),item_changes:z.array(item).max(32)}).strict().superRefine((r,c)=>{
 const bad=m=>c.addIssue({code:'custom',message:m});
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
// Envelope accepts unknown record fields for per-ID validation; missing/invalid ID rejects envelope.
export const EnvelopeSchema=z.object({schema_version:z.literal(1),batch_id:id,records:z.array(z.object({record_id:id}).passthrough()).min(1).max(50)}).strict().superRefine((b,c)=>{if(new Set(b.records.map(r=>r.record_id)).size!==b.records.length)c.addIssue({code:'custom',message:'duplicate_record_id_in_batch'});});
export const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export function validateBatch(raw){
 if(Buffer.byteLength(raw,'utf8')>LIMITS.max_batch_bytes)return {http:413,error:'batch_too_large'};
 let v;try{v=JSON.parse(raw);}catch{return {http:400,error:'invalid_json'};}
 if(Array.isArray(v?.records)&&v.records.length>50)return {http:413,error:'batch_too_large'};
 const e=EnvelopeSchema.safeParse(v);if(!e.success)return {http:400,error:'invalid_envelope'};
 if(e.data.records.some(r=>Buffer.byteLength(canonical(r),'utf8')>LIMITS.max_record_bytes))return {http:413,error:'record_too_large'};
 return {http:200,batch_id:e.data.batch_id,valid:e.data.records.filter(r=>RecordSchema.safeParse(r).success),rejected:e.data.records.filter(r=>!RecordSchema.safeParse(r).success).map(r=>({record_id:r.record_id,reason:'invalid_record',retryable:false}))};
}
const reason=z.enum(['invalid_record','record_id_conflict','sequence_conflict','business_source_conflict','before_origin_grant','item_reference_conflict','capacity_exceeded']);
export const AckSchema=z.object({ok:z.literal(true),data:z.object({schema_version:z.literal(1),batch_id:id,accepted_record_ids:z.array(id).max(50),duplicated_record_ids:z.array(id).max(50),rejected:z.array(z.object({record_id:id,reason,retryable:z.boolean()}).strict()).max(50),server_received_ms:time}).strict()}).strict().superRefine((a,c)=>{
 const d=a.data,ids=[...d.accepted_record_ids,...d.duplicated_record_ids,...d.rejected.map(x=>x.record_id)];
 if(ids.length>50||new Set(ids).size!==ids.length)c.addIssue({code:'custom',message:'ack_partition_invalid'});
 if(d.rejected.some(x=>x.retryable!==(x.reason==='capacity_exceeded')))c.addIssue({code:'custom',message:'retryability_invalid'});
});
export function acknowledgedIds(request,ack){
 const a=AckSchema.safeParse(ack);if(!a.success||a.data.data.batch_id!==request.batch_id)return [];
 const d=a.data.data,requestIds=new Set(request.records.map(r=>r.record_id));
 if([...d.accepted_record_ids,...d.duplicated_record_ids,...d.rejected.map(x=>x.record_id)].some(id=>!requestIds.has(id)))return [];
 return [...d.accepted_record_ids,...d.duplicated_record_ids]; // Missing request IDs remain pending.
}
export const ContextSchema=z.object({ok:z.literal(true),data:z.object({schema_version:z.literal(1),contract_version:z.literal(CONTRACT),origin_grant_id:z.string().uuid(),origin_epoch:seq,not_before_ms:time,server_time_ms:time,limits:z.object(Object.fromEntries(Object.entries(LIMITS).map(([k,v])=>[k,z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)]))).strict()}).strict()}).strict();
export const QuerySchema=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().min(1).max(2048).optional(),save_id:id.optional(),resource_id:resourceId.optional(),from_day:day.optional(),to_day:day.optional()}).strict().refine(q=>!q.from_day||!q.to_day||q.from_day<=q.to_day,'invalid_day_range');
const coverage=z.object({kind:z.literal('received_records'),complete:z.literal(false),reason:z.literal('partial_history'),min_occurred_at_ms:time.nullable(),max_occurred_at_ms:time.nullable(),first_received_at_ms:time.nullable(),last_received_at_ms:time.nullable()}).strict();
const summaryReason=z.enum(['policy_pending','no_records','non_normal','partial_history','clock_unknown','save_unknown','legacy_baseline_unknown','not_enabled','identity_mismatch']).nullable();
const acquiredItem=z.object({item_instance_id:id,item_id:id,item_kind:z.enum(['tank_component','avatar_decoration','unknown']),quantity:count.min(1),state:z.enum(['pending_activation','active','unknown']),activation_record_id:id.nullable()}).strict();
export const DashboardRecordsSchema=z.object({schema_version:z.literal(1),coverage,updated_at_ms:time.nullable(),yesterday_income:z.object({available:z.boolean(),reason:summaryReason,date:day,timezone:z.literal('Asia/Shanghai'),source_mode:z.literal('normal').nullable(),family_coin:count.nullable(),stardust:count.nullable(),occurred_from_ms:time.nullable(),occurred_to_ms:time.nullable(),received_at_ms:time.nullable()}).strict(),latest_items:z.object({available:z.boolean(),reason:summaryReason,source_mode:z.literal('normal').nullable(),record_id:id.nullable(),save_id:id.nullable(),occurred_at_ms:time.nullable(),received_at_ms:time.nullable(),items:z.array(acquiredItem).max(32)}).strict()}).strict().superRefine((v,c)=>{
 for(const s of [v.yesterday_income,v.latest_items])if(s.available&&s.source_mode!=='normal')c.addIssue({code:'custom',message:'available_summary_requires_normal'});
 if(!v.yesterday_income.available&&(v.yesterday_income.family_coin!==null||v.yesterday_income.stardust!==null))c.addIssue({code:'custom',message:'unavailable_income_requires_null'});
 if(!v.latest_items.available&&(v.latest_items.items.length||v.latest_items.record_id!==null))c.addIssue({code:'custom',message:'unavailable_items_requires_empty'});
});
// Validate the same immutable record fields but do not expose authority context in parent results.
export const ParentRecordSchema=z.any().superRefine((v,c)=>{
 if(!v||typeof v!=='object'||Array.isArray(v)||'origin_grant_id' in v||'origin_epoch' in v){c.addIssue({code:'custom',message:'invalid_parent_record'});return;}
 const {received_at_ms,time_status,item_references,...r}=v;
 if(!z.array(z.object({item_instance_id:id,acquired_record_id:id,status:z.enum(['pending','resolved'])}).strict()).max(32).safeParse(item_references).success){c.addIssue({code:'custom',message:'invalid_item_references'});return;}
 if(!time.safeParse(received_at_ms).success||!z.enum(['reported','unknown','clock_suspect']).safeParse(time_status).success||!RecordSchema.safeParse({...r,origin_grant_id:'00000000-0000-4000-8000-000000000001',origin_epoch:1}).success)c.addIssue({code:'custom',message:'invalid_parent_record'});
});
export const PageSchema=z.object({ok:z.literal(true),data:z.object({schema_version:z.literal(1),items:z.array(ParentRecordSchema).max(50),next_cursor:z.string().min(1).max(2048).nullable(),has_more:z.boolean(),coverage,updated_at_ms:time.nullable()}).strict()}).strict().refine(v=>v.data.has_more===(v.data.next_cursor!==null),'cursor_consistency');
