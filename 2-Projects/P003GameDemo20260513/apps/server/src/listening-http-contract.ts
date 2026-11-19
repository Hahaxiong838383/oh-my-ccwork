import { z } from 'zod';
import { createHash } from 'node:crypto';
import { validateDeviceSn } from './device-sn.js';
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive=integer.refine(x=>x>0);
const id=z.string().min(1).max(96).regex(/^[A-Za-z0-9_.:-]+$/);
const label=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const chars=(max:number)=>z.string().refine(x=>Array.from(x).length<=max);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const LISTENING_VOICE_CAPABILITY='listening_voice_control_v1' as const;
export const LISTENING_WORKER_CAPABILITIES=['listening_mode_v1','listening_http_v1','per_frame_output_permit_v1','capture_drain_v1','local_ready_ack_v1'] as const;
export function validListeningWorkerCapabilities(value:unknown):value is string[] {
 return Array.isArray(value)&&value.length>=5&&value.length<=6&&new Set(value).size===value.length
  &&LISTENING_WORKER_CAPABILITIES.every(c=>value.includes(c))
  &&value.every(c=>[...LISTENING_WORKER_CAPABILITIES,LISTENING_VOICE_CAPABILITY].includes(c));
}
export const listeningSessionSchema=z.object({sn:z.string().refine(x=>validateDeviceSn(x).ok),room:z.string().max(96),session_id:label,
 trace_id:z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),account_id:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)}).strict()
 .refine(x=>new RegExp(`^sn-${x.sn}-\\d{1,20}$`).test(x.room));
const common={version:z.literal(1),request_id:id,session:listeningSessionSchema,listening_id:id,scene:z.enum(['story','sharing','singing']),mode_epoch:integer};
const segment=z.object({seq:positive,revision:positive,text:chars(12000).refine(x=>!!x.trim())}).strict();
const schemas={
 '/worker-ready':z.object({version:z.literal(1),request_id:id,agent:label,instance_id:label,build_sha:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
 registered:z.boolean(),capabilities:z.array(z.enum([...LISTENING_WORKER_CAPABILITIES,LISTENING_VOICE_CAPABILITY])).refine(validListeningWorkerCapabilities),applied_revision:positive.nullable(),applied_config_sha256:sha.nullable()}).strict(),
 '/lease':z.object({...common,applied_snapshot_sha256:sha.nullable()}).strict(),
 '/close':z.object(common).strict(),
 '/summary':z.object({...common,snapshot_revision:positive,snapshot_sha256:sha,base_summary_version:integer,previous_summary:chars(1200),has_gap:z.boolean(),
 segments:z.array(segment).min(1).max(128)}).strict().refine(x=>x.segments.every((s,i)=>i===0||s.seq===x.segments[i-1].seq+1)
 &&x.segments.reduce((n,s)=>n+Array.from(s.text).length,0)<=12000),
 '/feedback':z.object({...common,snapshot_revision:positive,snapshot_sha256:sha,summary:chars(1200),recent:chars(4000),question:chars(500),has_gap:z.boolean(),trigger:z.enum(['button','voice_invitation','voice_command'])}).strict(),
} as const;
export type ListeningPath=keyof typeof schemas;
export type SessionWire=z.infer<typeof listeningSessionSchema>;
export type ListeningRequest<P extends ListeningPath>=z.infer<(typeof schemas)[P]>;
export function parseListeningRequest<P extends ListeningPath>(path:P,body:unknown):ListeningRequest<P>|null;
export function parseListeningRequest(path:string,body:unknown):any|null {
 const schema=schemas[path as ListeningPath];if(!schema)return null;
 const result=schema.safeParse(body);if(!result.success)return null;
 const value=result.data;
 if('session' in value){
  const prefix=value.session.trace_id+':';
  if(!value.listening_id.startsWith(prefix))return null;
  const seq=value.listening_id.slice(prefix.length);
  if(!/^[1-9]\d{0,15}$/.test(seq)||!Number.isSafeInteger(Number(seq)))return null;
 }
 return value;
}
export function canonicalJson(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value);
}
export function listeningDigest(value:unknown):string{return createHash('sha256').update(canonicalJson(value)).digest('hex');}
export const LISTENING_HTTP_LIMITS={raw_chars:12000,recent_chars:4000,summary_chars:1200,lease_ttl_ms:15000,lease_refresh_ms:5000,lease_request_budget_ms:1000} as const;
