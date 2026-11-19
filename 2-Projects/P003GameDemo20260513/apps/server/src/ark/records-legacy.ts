import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonical, RecordsError, type BusinessRecord} from './records-contract.js';

/** The known mini009 wire, not an alias for the strict origin-bearing v1. */
export const LEGACY_CONTRACT = 'p003-ark-records-r1';
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,96}$/);
const text = z.string().max(256);
const key = text.min(1);
const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const integer = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const mode = z.enum(['normal','gm','unknown']);
const state = z.enum(['active','pending_activation']);
const inventory = z.object({item_id:key,kind:text.nullable(),quantity:natural.max(0xffffffff),
 tank_id:text.nullable(),layer:text.nullable(),status:state,acquired_at_ms:natural}).strict();
const walletChange = z.object({resource_id:key,before:integer,after:integer,delta:integer}).strict()
 .refine(v=>v.delta!==0&&Number.isSafeInteger(v.after-v.before)&&v.after-v.before===v.delta,'balance_delta_mismatch');
const inventoryChange = z.object({item_id:key,before:inventory.nullable(),after:inventory.nullable()}).strict()
 .refine(v=>(v.before!==null||v.after!==null)&&(!v.before||v.before.item_id===v.item_id)&&(!v.after||v.after.item_id===v.item_id),'inventory_identity_mismatch');
const reward = z.object({kind:text,item_id:key,quantity:natural.max(0xffffffff),tank_id:text.nullable(),layer:text.nullable()}).strict();
const grant = z.object({reward_instance_id:key,source_kind:text,source_id:text,logical_day:text,
 resolved_rewards:z.array(reward).max(256),status:z.literal('granted'),config_revision:text,granted_at_ms:natural}).strict();
const common = {record_id:id,save_id:id,sequence:natural.min(1),occurred_at_ms:natural,logical_day:text.nullable(),
 source_mode:mode,config_revision:text,active_ecotank_id:text.nullable()};
const baselineData = z.object({wallet:z.record(z.string().regex(/^[A-Z][A-Za-z0-9_-]{0,63}$/),integer)
 .refine(v=>Object.keys(v).length<=256,'wallet_limit'),inventory:z.array(inventory).max(256),history_complete_before_baseline:z.literal(false)}).strict();
const commitData = z.object({wallet_changes:z.array(walletChange).max(256),inventory_changes:z.array(inventoryChange).max(256),
 grants:z.array(grant).max(256),makeup_grants:z.array(z.object({tank_id:text}).strict()).max(256),
 makeup_uses:z.array(z.object({tank_id:text.nullable(),logical_day:text,usage_day_index:natural}).strict()).max(256),previous_source_mode:mode}).strict();
export const LegacyRecordSchema = z.discriminatedUnion('record_kind',[
 z.object({...common,record_kind:z.literal('baseline'),data:baselineData}).strict(),
 z.object({...common,record_kind:z.literal('business_commit'),data:commitData}).strict(),
]).superRefine((r,c)=>{
 const bad=(message:string)=>c.addIssue({code:'custom',message});
 if(r.record_id!==`${r.save_id}:${r.sequence}`)bad('record_identity_mismatch');
 const unique=(values:string[])=>new Set(values).size===values.length;
 if(r.record_kind==='baseline'){
  if(!unique(r.data.inventory.map(x=>x.item_id)))bad('duplicate_inventory_item');
 }else{
  if(!unique(r.data.wallet_changes.map(x=>x.resource_id)))bad('duplicate_wallet_resource');
  if(!unique(r.data.inventory_changes.map(x=>x.item_id)))bad('duplicate_inventory_item');
  if(!unique(r.data.grants.map(x=>x.reward_instance_id)))bad('duplicate_reward_instance');
  if(!unique(r.data.makeup_grants.map(x=>x.tank_id)))bad('duplicate_makeup_grant');
  if(!unique(r.data.makeup_uses.map(x=>x.logical_day)))bad('duplicate_makeup_use');
 }
});
export type LegacyRecord = z.infer<typeof LegacyRecordSchema>;
type Commit = Extract<LegacyRecord,{record_kind:'business_commit'}>;
type ResourceId = BusinessRecord['resource_changes'][number]['resource_id'];
type ItemKind = 'tank_component'|'avatar_decoration'|'unknown';

function boundedTree(value:unknown){
 const pending:[unknown,number][]=[[value,0]];let nodes=0;
 while(pending.length){const [v,depth]=pending.pop()!;
  if(depth>12||++nodes>12000)throw new RecordsError(400,'invalid_envelope');
  if(v!==null&&typeof v==='object')for(const x of Object.values(v))pending.push([x,depth+1]);
 }
}
export function parseLegacyBatch(value:unknown){
 boundedTree(value);
 let serialized:string;try{serialized=JSON.stringify(value);}catch{throw new RecordsError(400,'invalid_envelope');}
 if(typeof serialized!=='string')throw new RecordsError(400,'invalid_envelope');
 if(Buffer.byteLength(serialized)>65536)throw new RecordsError(413,'batch_too_large');
 if(value&&typeof value==='object'&&Array.isArray((value as any).records)&&(value as any).records.length>16)throw new RecordsError(413,'batch_too_large');
 const parsed=z.object({schema_version:z.literal(1),contract_id:z.literal(LEGACY_CONTRACT),batch_id:id,save_id:id,
  coverage_from_ms:natural,dropped_records:natural,records:z.array(z.object({record_id:id}).passthrough()).min(1).max(16)}).strict().safeParse(value);
 if(!parsed.success)throw new RecordsError(400,'invalid_envelope');
 const b=parsed.data;
 if(new Set(b.records.map(r=>r.record_id)).size!==b.records.length)throw new RecordsError(400,'duplicate_record_id_in_batch');
 if(b.records.some(r=>Buffer.byteLength(JSON.stringify(r))>32768))throw new RecordsError(413,'record_too_large');
 return {...b,records:b.records.map(raw=>({raw,parsed:LegacyRecordSchema.refine(r=>r.save_id===b.save_id,'batch_save_mismatch').safeParse(raw)}))};
}

/** Known identifiers are mapped explicitly; unfamiliar resources remain raw facts. */
export function legacyResourceId(value:string):ResourceId|null {
 if(value==='C-FAMILY-001')return 'family_coin';
 if(value==='C-STARDUST-001')return 'stardust';
 if(value==='M-CARD-001')return 'M-CARD-001';
 return null;
}
function itemKind(value:string|null):ItemKind {
 if(value==='ecotank_part'||value==='tank_component')return 'tank_component';
 if(value==='character_state'||value==='avatar_decoration')return 'avatar_decoration';
 return 'unknown';
}
const wallClock=(value:number)=>value>0&&value<=8e12?value:null;
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
// These source kinds are created by mini009 G1 reward/gift/route/chest producers.
const rewardSources=new Set(['newcomer_gift','daily_gift','progress_stage','route_day','chest_open']);
export type LegacyIncomeGrant={reward_instance_id:string;fingerprint:string;occurred_at_ms:number;family_coin:number|null;stardust:number|null};

/** Per-grant facts, not aggregate sums. The store deduplicates the stable reward ID
 * within its explicit authorization + save scope, rejecting conflicting fingerprints. */
export function legacyIncomeGrants(record:LegacyRecord, verifiedTasks:ReadonlySet<string>=new Set()):LegacyIncomeGrant[]{
 if(record.record_kind!=='business_commit'||record.source_mode!=='normal')return [];
 const occurred=wallClock(record.occurred_at_ms);if(occurred===null)return [];
 const totals:Record<'family_coin'|'stardust',number>={family_coin:0,stardust:0};
 const invalid=new Set<string>();
 const candidates:LegacyIncomeGrant[]=[];
 for(const g of record.data.grants){
  const known=(rewardSources.has(g.source_kind)||(g.source_kind==='parent_task'&&verifiedTasks.has(g.reward_instance_id)))&&g.source_id.length>0;
  // Runtime journal.observe gets SystemTime::now at durable state commit. In
  // contrast, granted_at_ms comes from request now_ms and is only an original fact.
  const row:LegacyIncomeGrant={reward_instance_id:g.reward_instance_id,fingerprint:hash(g),occurred_at_ms:occurred,family_coin:null,stardust:null};
  for(const reward of g.resolved_rewards){
   // mini009 apply_resolved_reward explicitly deposits the historical coin ID
   // into C-FAMILY-001. This alias applies to grants, not arbitrary raw wallet keys.
   const resource=legacyResourceId(reward.item_id==='C-COIN-001'?'C-FAMILY-001':reward.item_id);
   if(resource!=='family_coin'&&resource!=='stardust')continue;
   if(!known||reward.kind!=='currency'||reward.quantity===0){invalid.add(resource);continue;}
   totals[resource]+=reward.quantity;
   row[resource]=(row[resource]??0)+reward.quantity;
   if(!Number.isSafeInteger(totals[resource])||!Number.isSafeInteger(row[resource]))invalid.add(resource);
  }
  if(known)candidates.push(row);
 }
 for(const resource of ['family_coin','stardust'] as const){
  const change=record.data.wallet_changes.find(x=>legacyResourceId(x.resource_id)===resource);
  if(!change||change.delta<=0||change.delta!==totals[resource])invalid.add(resource);
 }
 return candidates.map(row=>({...row,family_coin:invalid.has('family_coin')?null:row.family_coin,
  stardust:invalid.has('stardust')?null:row.stardust})).filter(row=>row.family_coin!==null||row.stardust!==null);
}

/** Includes uncertain/GM candidates, so choosing the latest cannot fall back to an
 * older normal acquisition merely because the newest evidence is incomplete. */
export function legacyHasAcquisition(record:LegacyRecord){
 return record.record_kind==='business_commit'&&(
  record.data.inventory_changes.some(x=>x.item_id!=='M-CARD-001'&&(x.after?.quantity??0)>(x.before?.quantity??0))||
  record.data.grants.some(g=>g.resolved_rewards.some(r=>r.item_id!=='M-CARD-001'&&r.kind!=='currency'&&r.quantity>0)));
}
export function legacyActivations(record:LegacyRecord):{item_id:string;state:'active'}[]{
 if(record.record_kind!=='business_commit')return [];
 return record.data.inventory_changes.filter(x=>x.item_id!=='M-CARD-001'&&x.before?.status==='pending_activation'&&x.after?.status==='active'&&
  x.after.quantity===x.before.quantity&&x.after.quantity>0).map(x=>({item_id:x.item_id,state:'active'}));
}
type DerivedAcquisition={operation:'acquired';item_instance_id:string;item_identity_source:'legacy_derived';item_id:string;item_kind:ItemKind;
 quantity:number;state:'pending_activation'|'active';acquisition_evidence:'grant_and_inventory'|'inventory_change'};
function acquisitions(record:Commit):DerivedAcquisition[]{
 return record.data.inventory_changes.flatMap(change=>{
  const quantity=(change.after?.quantity??0)-(change.before?.quantity??0);
  if(change.item_id==='M-CARD-001'||!change.after||quantity<=0)return [];
  const matching=record.data.grants.flatMap(g=>g.resolved_rewards.map((reward,index)=>({g,reward,index})))
   .filter(x=>x.reward.kind!=='currency'&&x.reward.item_id===change.item_id&&x.reward.quantity>0);
  const matchedQuantity=matching.reduce((n,x)=>n+x.reward.quantity,0);
  // The original inventory increase is itself a business fact. A missing grant
  // does not erase it; a derived display key is never claimed as an original instance.
  const evidence=matching.length>0&&matchedQuantity===quantity;
  const identity=evidence?matching.map(x=>[x.g.reward_instance_id,x.index]):[record.record_id,change.item_id];
  return [{operation:'acquired' as const,item_instance_id:`legacy:${hash([record.save_id,identity]).slice(0,48)}`,
   item_identity_source:'legacy_derived' as const,item_id:change.item_id,item_kind:itemKind(change.after.kind),quantity,
   state:change.after.status,acquisition_evidence:evidence?'grant_and_inventory' as const:'inventory_change' as const}];
 });
}

export type LegacyDisplayRecord={
 record_id:string;save_id:string;sequence:number;occurred_at_ms:number|null;time_quality:'reported'|'unknown';logical_day:string|null;
 source_mode:LegacyRecord['source_mode'];reason:BusinessRecord['reason'];business_source_id:string|null;tank_id:string|null;stage_id:string|null;
 format:typeof LEGACY_CONTRACT;contract_id:typeof LEGACY_CONTRACT;record_kind:LegacyRecord['record_kind'];
 authorization_source:'legacy_explicit_scope';origin_verified:false;config_revision:string;
 resource_changes:BusinessRecord['resource_changes'];item_changes:DerivedAcquisition[];
 resource_conflicts:string[];
 unmapped_resource_changes:z.infer<typeof walletChange>[];
 inventory_state_changes:{item_id:string;from_state:string;to_state:string;quantity:number}[];
 // Preserved business facts for history readers; these never imply normal income.
 grants:Commit['data']['grants'];inventory_changes:Commit['data']['inventory_changes'];
 makeup_grants:Commit['data']['makeup_grants'];makeup_uses:Commit['data']['makeup_uses'];
 baseline?:{wallets:{family_coin:number|null;stardust:number|null;'M-CARD-001':number|null};items:{item_id:string;quantity:number;state:string;item_kind:ItemKind}[]};
};
export function projectLegacyRecord(record:LegacyRecord, verifiedTasks:ReadonlySet<string>=new Set()):LegacyDisplayRecord {
 const occurred=wallClock(record.occurred_at_ms);
 const result:LegacyDisplayRecord={record_id:record.record_id,save_id:record.save_id,sequence:record.sequence,occurred_at_ms:occurred,
  time_quality:occurred===null?'unknown':'reported',logical_day:record.logical_day,source_mode:record.source_mode,
  reason:'unknown',business_source_id:null,tank_id:record.active_ecotank_id,stage_id:null,
  format:LEGACY_CONTRACT,contract_id:LEGACY_CONTRACT,record_kind:record.record_kind,
  authorization_source:'legacy_explicit_scope',origin_verified:false,config_revision:record.config_revision,
  resource_changes:[],item_changes:[],resource_conflicts:[],unmapped_resource_changes:[],inventory_state_changes:[],
  grants:[],inventory_changes:[],makeup_grants:[],makeup_uses:[]};
 if(record.record_kind==='baseline'){
  const inventoryCard=record.data.inventory.find(x=>x.item_id==='M-CARD-001')?.quantity;
  const walletCard=record.data.wallet['M-CARD-001'];
  const conflict=inventoryCard!==undefined&&walletCard!==undefined&&inventoryCard!==walletCard;
  if(conflict)result.resource_conflicts.push('M-CARD-001');
  result.baseline={wallets:{family_coin:record.data.wallet['C-FAMILY-001']??null,stardust:record.data.wallet['C-STARDUST-001']??null,
   'M-CARD-001':conflict?null:inventoryCard??walletCard??null},items:record.data.inventory.filter(x=>x.item_id!=='M-CARD-001').map(x=>({item_id:x.item_id,quantity:x.quantity,state:x.status,item_kind:itemKind(x.kind)}))};
  return result;
 }
 result.grants=record.data.grants;result.inventory_changes=record.data.inventory_changes;
 result.makeup_grants=record.data.makeup_grants;result.makeup_uses=record.data.makeup_uses;
 const inventoryCard=record.data.inventory_changes.find(x=>x.item_id==='M-CARD-001');
 for(const change of record.data.wallet_changes){
  if(inventoryCard&&change.resource_id==='M-CARD-001')continue;
  const mapped=legacyResourceId(change.resource_id);
  if(mapped)result.resource_changes.push({...change,resource_id:mapped});else result.unmapped_resource_changes.push({...change});
 }
 if(inventoryCard){
  const before=inventoryCard.before?.quantity??0,after=inventoryCard.after?.quantity??0,delta=after-before;
  const walletCard=record.data.wallet_changes.find(x=>x.resource_id==='M-CARD-001');
  if(walletCard&&(walletCard.before!==before||walletCard.after!==after||walletCard.delta!==delta))result.resource_conflicts.push('M-CARD-001');
  else if(delta!==0)result.resource_changes.push({resource_id:'M-CARD-001',before,after,delta});
 }
 result.item_changes=acquisitions(record);
 result.inventory_state_changes=record.data.inventory_changes.filter(x=>x.before&&x.after&&x.before.status!==x.after.status)
  .map(x=>({item_id:x.item_id,from_state:x.before!.status,to_state:x.after!.status,quantity:x.after!.quantity}));
 const activations=legacyActivations(record);
 if(record.source_mode==='gm')result.reason='gm_adjustment';
 else if(activations.length&&activations.length===record.data.inventory_changes.length&&!record.data.wallet_changes.length&&!record.data.grants.length&&!record.data.makeup_grants.length&&!record.data.makeup_uses.length)result.reason='item_activation';
 else if(record.data.grants.length&&record.data.grants.every(g=>rewardSources.has(g.source_kind)||(g.source_kind==='parent_task'&&verifiedTasks.has(g.reward_instance_id)))&&
  !record.data.makeup_grants.length&&!record.data.makeup_uses.length&&!activations.length&&
  record.data.wallet_changes.every(x=>x.delta>0)&&
  (legacyIncomeGrants(record,verifiedTasks).length>0||result.item_changes.length>0))result.reason='reward_claim';
 else if(record.data.makeup_grants.length&&!record.data.grants.length&&!record.data.makeup_uses.length)result.reason='tank_unlock';
 else if(record.data.makeup_uses.length&&!record.data.grants.length&&!record.data.makeup_grants.length&&!result.item_changes.length)result.reason='makeup_card_use';
 else if(record.data.wallet_changes.length&&record.data.wallet_changes.every(x=>x.delta<0)&&!record.data.grants.length&&!activations.length)result.reason='resource_spend';
 return result;
}
