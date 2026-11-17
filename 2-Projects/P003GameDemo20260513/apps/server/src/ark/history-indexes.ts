import type {DatabaseSync} from 'node:sqlite';

// Offline, additive indexes only. Do not build populated indexes during HTTP startup.
export const ARK_HISTORY_INDEXES = {
 evidence: {name:'analytics_ark_evidence_cover_v1',events:['g1.logical_day_changed','g1.command_failed','g1.runtime_command_completed','g1.gift_became_available','g1.gift_claimed','g1.reward_granted']},
 assets: {name:'analytics_ark_assets_cover_v1',events:['g1.wallet_balance_changed','g1.inventory_changed','g1.makeup_card_balance_changed']},
 daily: {name:'analytics_ark_daily_cover_v1',events:['g1.progress_checkpoint','g1.reward_granted']},
} as const;

export function installArkHistoryIndexes(db:DatabaseSync){
 if(db.isTransaction)throw new Error('ARK_HISTORY_INDEX_REQUIRES_OWN_TRANSACTION');
 const created:string[]=[];db.exec('BEGIN IMMEDIATE');
 try{
  for(const {name,events} of Object.values(ARK_HISTORY_INDEXES)){
   const sql=`CREATE INDEX ${name} ON analytics_event(device_key,event_name,received_at_ms DESC,occurred_at_ms DESC,clock_suspicious,properties_json,batch_attempt_id,session_id,client_event_id) WHERE event_name IN (${events.map(e=>"'"+e+"'").join(',')})`;
   const old=db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(name);
   if(old){if(old.sql!==sql)throw new Error('ARK_HISTORY_INDEX_DEFINITION_CONFLICT');continue;}
   db.exec(sql);created.push(name);
  }
  db.exec('COMMIT');return {created};
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}

/** Schema lookup only: no profile, grant or history caching. Older DBs keep their existing index. */
export function arkHistoryReadIndexes(db:DatabaseSync){
 const present=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='analytics_event' AND name IN (?,?,?)").all(...Object.values(ARK_HISTORY_INDEXES).map(x=>x.name)).map(x=>x.name));
 return Object.fromEntries(Object.entries(ARK_HISTORY_INDEXES).map(([kind,{name}])=>[kind,present.has(name)?name:'analytics_ark_device_event_received'])) as Record<keyof typeof ARK_HISTORY_INDEXES,string>;
}
