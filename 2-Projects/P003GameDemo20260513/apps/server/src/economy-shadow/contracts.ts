import {createHash} from 'node:crypto';
import {z} from 'zod';

export const ENGINE_VERSION='p003-shadow-v1';
export const MAX_ROWS=10000;
export const DAY_MS=86400000;
const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:/@+\-]+$/);
const ms=z.number().int().min(1).max(8e12);
const observationSchema=z.object({id, name:id, session:id.nullable(),occurred_at_ms:ms,received_at_ms:ms,clock_suspicious:z.boolean(),clock_skew_ms:z.number().int().nullable(),version:id.nullable(),data:z.record(z.unknown())}).strict();
export const inputSchema=z.object({schema_version:z.literal(1),subject:z.string().regex(/^BJP003\d{14}$/),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),cutoff_ms:ms,analytics:z.array(observationSchema).max(MAX_ROWS),telemetry:z.array(observationSchema).max(MAX_ROWS),truncated:z.object({analytics:z.boolean(),telemetry:z.boolean()}).strict()}).strict();
export type Observation=z.infer<typeof observationSchema>;
export type ReplayInput=z.infer<typeof inputSchema>;
export type Basis='telemetry_union'|'checkpoint_max';
const ruleSchema=z.object({schema_version:z.literal(1),purpose:z.literal('scenario_only'),revision:id,source_sha256:z.string().regex(/^[a-f0-9]{64}$/),stages:z.array(z.object({id,target_seconds:z.number().int().min(1).max(86400),rewards:z.array(z.object({item_id:id,quantity:z.number().int().min(1).max(1e6)}).strict()).min(1).max(8)}).strict()).min(1).max(64)}).strict().superRefine((r,ctx)=>{
 if(new Set(r.stages.map(s=>s.id)).size!==r.stages.length||r.stages.some((s,i)=>i>0&&s.target_seconds<=r.stages[i-1].target_seconds))ctx.addIssue({code:'custom',message:'stages_must_be_unique_and_increasing'});
});
export type ScenarioRule=z.infer<typeof ruleSchema>;
export const parseRule=(r:unknown)=>ruleSchema.parse(r);
export function dayBounds(day:string){const start=Date.parse(day+'T00:00:00+08:00');if(!Number.isFinite(start)||new Date(start+28800000).toISOString().slice(0,10)!==day)throw new Error('invalid_day');return {start,end:start+DAY_MS};}
export function canonical(value:unknown,depth=0):string{
 if(depth>12)throw new Error('json_too_deep');
 if(value===null)return 'null';
 if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
 if(typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k],depth+1)).join(',')+'}';
 if(typeof value==='number'&&!Number.isFinite(value)||!['number','string','boolean'].includes(typeof value))throw new Error('invalid_json_value');
 return JSON.stringify(value);
}
export const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
export function parseInput(raw:unknown):ReplayInput{
 const i=inputSchema.parse(raw),{start,end}=dayBounds(i.day);
 if(i.cutoff_ms<start||i.cutoff_ms>end+31*DAY_MS)throw new Error('invalid_cutoff');
 for(const e of [...i.analytics,...i.telemetry])if(Buffer.byteLength(canonical(e.data))>8192)throw new Error('payload_too_large');
 return i;
}
