import {z} from 'zod';
export const SN=z.string().regex(/^BJP003\d{14}$/);
const id=z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);
const count=z.number().int().min(0).max(1_000_000_000);
const timestamp=z.number().int().min(1).max(8_000_000_000_000);
export const daySchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d=>{const n=Date.parse(d+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===d;});
const reward=z.object({status:z.enum(['locked','claimable','claimed','day_complete','unknown']),kind:z.enum(['currency','chest','item','unknown']),item_id:z.enum(['C-FAMILY-001','M-CARD-001']).nullable(),stage_id:id.nullable(),remaining_seconds:z.number().int().min(0).max(86400).nullable()}).strict();
export const snapshotSchema=z.object({schema_version:z.literal(1),snapshot_id:id,captured_at_ms:timestamp,boot_id:id,boot_started_at_ms:timestamp,sequence:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),logical_day:daySchema,config_revision:id,content_version:id,source_mode:z.enum(['normal','gm','unknown']),wallets:z.object({family_coin:count.nullable(),stardust:count.nullable()}).strict(),inventory:z.object({'M-CARD-001':count.nullable()}).strict(),progress:z.object({timer_state:z.enum(['running','paused','stopped','unknown']),next_reward:reward,claimable_count:count.nullable()}).strict()}).strict().superRefine((s,ctx)=>{
 const r=s.progress.next_reward;
 if(s.boot_started_at_ms>s.captured_at_ms)ctx.addIssue({code:'custom',message:'boot_after_capture'});
 if(r.status==='locked'&&(r.remaining_seconds===null||r.remaining_seconds===0||r.kind==='unknown'))ctx.addIssue({code:'custom',message:'locked_requires_remaining_and_kind'});
 if(r.status==='claimable'&&(r.remaining_seconds!==0||r.kind==='unknown'||!s.progress.claimable_count))ctx.addIssue({code:'custom',message:'claimable_requires_zero_and_count'});
 if(['claimed','day_complete','unknown'].includes(r.status)&&r.remaining_seconds!==null)ctx.addIssue({code:'custom',message:'non_countdown_requires_null'});
 if(r.kind==='currency'&&r.item_id!=='C-FAMILY-001')ctx.addIssue({code:'custom',message:'currency_item_unknown'});
 if(r.kind==='item'&&r.item_id!=='M-CARD-001')ctx.addIssue({code:'custom',message:'inventory_item_unknown'});
 if(['chest','unknown'].includes(r.kind)&&r.item_id!==null)ctx.addIssue({code:'custom',message:'non_item_requires_null'});
});
export type ArkSnapshot=z.infer<typeof snapshotSchema>;
export type ArkCurrent={snapshot:ArkSnapshot;received_at_ms:number};
export const factSchema=z.object({value:count,occurred_at_ms:timestamp,received_at_ms:timestamp,content_version:id.nullable()}).strict();
export const historySchema=z.object({ok:z.literal(true),status:z.enum(['available','unknown']),reason:z.enum(['none','no_trusted_events','query_limit']),wallets:z.object({family_coin:factSchema.nullable(),stardust:factSchema.nullable()}).strict(),inventory:z.object({'M-CARD-001':factSchema.nullable()}).strict()}).strict();
export type ArkHistory=z.infer<typeof historySchema>;
export const unknownHistory=(reason:ArkHistory['reason']='no_trusted_events'):ArkHistory=>({ok:true,status:'unknown',reason,wallets:{family_coin:null,stardust:null},inventory:{'M-CARD-001':null}});
export const historyRequestSchema=z.object({subject:SN,account_id:z.string().min(1).max(128),epoch:z.number().int().min(1),not_before_ms:timestamp}).strict();
export const settingsSchema=z.object({enabled:z.boolean(),subjects:z.array(SN).max(32).refine(a=>new Set(a).size===a.length),expected_revision:z.number().int().nonnegative()}).strict();
export const cstDay=(ms:number)=>new Date(ms+8*3600000).toISOString().slice(0,10);

/** Authority-resolved facts only. This is not a raw client snapshot transport. */
export const progressFactSchema=z.object({captured_at_ms:timestamp,received_at_ms:timestamp,logical_day:daySchema,
 timer_state:z.enum(['running','paused','stopped','unknown']),status:z.enum(['locked','claimable','claimed','day_complete','unknown']),
 kind:z.enum(['currency','chest','item','unknown']),item_id:z.enum(['C-FAMILY-001','M-CARD-001']).nullable(),
 remaining_seconds:z.number().int().min(0).max(86400).nullable(),claimable_count:count.nullable()}).strict().superRefine((p,c)=>{
 if(p.status==='locked'&&(!p.remaining_seconds||p.kind==='unknown'))c.addIssue({code:'custom',message:'invalid_locked'});
 if(p.status==='claimable'&&(p.remaining_seconds!==0||!p.claimable_count||p.kind==='unknown'))c.addIssue({code:'custom',message:'invalid_claimable'});
 if(['claimed','day_complete','unknown'].includes(p.status)&&p.remaining_seconds!==null)c.addIssue({code:'custom',message:'invalid_remaining'});
 if(p.kind==='currency'&&p.item_id!=='C-FAMILY-001'||p.kind==='item'&&p.item_id!=='M-CARD-001'||['chest','unknown'].includes(p.kind)&&p.item_id!==null)c.addIssue({code:'custom',message:'invalid_item'});
});
export const resolvedFactsSchema=z.object({schema_version:z.literal(1),assets:z.object({family_coin:factSchema.nullable(),stardust:factSchema.nullable(),makeup_card:factSchema.nullable()}).strict(),progress:progressFactSchema.nullable()}).strict();
export const wireFactsSchema=resolvedFactsSchema.extend({subject:SN});
export type ArkFacts=z.infer<typeof resolvedFactsSchema>;
export type ArkReadResult={prompt:string;facts_v1?:z.infer<typeof wireFactsSchema>};
