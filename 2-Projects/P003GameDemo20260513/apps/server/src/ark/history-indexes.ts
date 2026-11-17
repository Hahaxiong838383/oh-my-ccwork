import type {DatabaseSync} from 'node:sqlite';

// Keep the read predicate and partial index identical: the index is only a
// smaller access path, never a different definition of normal/GM evidence.
export const ARK_EVIDENCE_FILTER=`event_name='g1.logical_day_changed' OR json_extract(properties_json,'$.gm_override')=1 OR json_extract(properties_json,'$.source_mode')='gm'
 OR lower(coalesce(json_extract(properties_json,'$.command'),'')||' '||coalesce(json_extract(properties_json,'$.source_kind'),'')) GLOB '*gm*'
 OR lower(coalesce(json_extract(properties_json,'$.command'),'')||' '||coalesce(json_extract(properties_json,'$.source_kind'),'')) GLOB '*debug*'
 OR lower(coalesce(json_extract(properties_json,'$.command'),'')||' '||coalesce(json_extract(properties_json,'$.source_kind'),'')) GLOB '*test*'`;
const LEGACY_EVIDENCE_INDEX='analytics_ark_evidence_cover_v1';
// Offline, additive indexes only. Do not build populated indexes during HTTP startup.
export const ARK_HISTORY_INDEXES = {
 evidence: {name:'analytics_ark_evidence_cover_v2',events:['g1.logical_day_changed','g1.command_failed','g1.runtime_command_completed','g1.gift_became_available','g1.gift_claimed','g1.reward_granted']},
 assets: {name:'analytics_ark_assets_cover_v1',events:['g1.wallet_balance_changed','g1.inventory_changed','g1.makeup_card_balance_changed']},
 daily: {name:'analytics_ark_daily_cover_v1',events:['g1.progress_checkpoint','g1.reward_granted']},
} as const;

export function installArkHistoryIndexes(db:DatabaseSync){
 if(db.isTransaction)throw new Error('ARK_HISTORY_INDEX_REQUIRES_OWN_TRANSACTION');
 const created:string[]=[];db.exec('BEGIN IMMEDIATE');
 try{
  for(const {name,events} of Object.values(ARK_HISTORY_INDEXES)){
   const evidence=name===ARK_HISTORY_INDEXES.evidence.name;
   const columns=evidence?'device_key,received_at_ms DESC,occurred_at_ms DESC,event_name,clock_suspicious,properties_json':'device_key,event_name,received_at_ms DESC,occurred_at_ms DESC,clock_suspicious,properties_json,batch_attempt_id,session_id,client_event_id';
   const sql=`CREATE INDEX ${name} ON analytics_event(${columns}) WHERE event_name IN (${events.map(e=>"'"+e+"'").join(',')})`+(evidence?` AND (${ARK_EVIDENCE_FILTER})`:'');
   const old=db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(name);
   if(old){if(old.sql!==sql)throw new Error('ARK_HISTORY_INDEX_DEFINITION_CONFLICT');continue;}
   db.exec(sql);created.push(name);
  }
  db.exec('COMMIT');return {created};
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}

/** Schema lookup only: no profile, grant or history caching. Older DBs keep their existing index. */
export function arkHistoryReadIndexes(db:DatabaseSync){
 const present=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='analytics_event' AND name IN (?,?,?,?)").all(...Object.values(ARK_HISTORY_INDEXES).map(x=>x.name),LEGACY_EVIDENCE_INDEX).map(x=>x.name));
 return Object.fromEntries(Object.entries(ARK_HISTORY_INDEXES).map(([kind,{name}])=>[kind,present.has(name)?name:kind==='evidence'&&present.has(LEGACY_EVIDENCE_INDEX)?LEGACY_EVIDENCE_INDEX:'analytics_ark_device_event_received'])) as Record<keyof typeof ARK_HISTORY_INDEXES,string>;
}
