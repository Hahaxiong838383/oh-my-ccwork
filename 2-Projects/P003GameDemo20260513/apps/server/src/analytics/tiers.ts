import type {AnalyticsStore} from './store.js';
import type {DatabaseSync} from 'node:sqlite';
import type {AnalyticsEvent,RejectReason} from './contracts.js';
import type {AnalyticsDeviceContext} from './device-context.js';
export const TIER_RETENTION_DAYS={raw:14,aggregate:90,diagnostic:3,statistics:90,receipts:14} as const;
export type AnalyticsTier='raw'|'aggregate'|'diagnostic';
export function eventTier(name:string):AnalyticsTier{return name==='analytics.periodic_aggregate'?'aggregate':name==='analytics.on_demand_sample'?'diagnostic':'raw';}
/** Additive tables only: the pre-v375 raw schema/INSERT shape remains rollback-compatible. */
export function initAnalyticsTiers(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS analytics_tier_event (
   device_key TEXT NOT NULL,client_event_id TEXT NOT NULL,event_name TEXT NOT NULL,
   occurred_at_ms INTEGER NOT NULL,received_at_ms INTEGER NOT NULL,session_id TEXT NOT NULL,
   sequence INTEGER NOT NULL,priority TEXT NOT NULL,context_json TEXT NOT NULL,properties_json TEXT NOT NULL,
   batch_attempt_id TEXT NOT NULL,occurred_day TEXT,received_day TEXT NOT NULL,clock_suspicious INTEGER NOT NULL,
   tier TEXT NOT NULL,source_event_name TEXT NOT NULL,source_event_count INTEGER NOT NULL,diagnostic_request_id TEXT,
   PRIMARY KEY(device_key,client_event_id));
   CREATE INDEX IF NOT EXISTS analytics_tier_expiry ON analytics_tier_event(tier,received_at_ms);
   CREATE INDEX IF NOT EXISTS analytics_tier_device_received ON analytics_tier_event(device_key,received_at_ms);
   CREATE INDEX IF NOT EXISTS analytics_tier_id_received ON analytics_tier_event(client_event_id,received_at_ms);
   CREATE TABLE IF NOT EXISTS analytics_tier_day (
   day TEXT NOT NULL,device_key TEXT NOT NULL,tier TEXT NOT NULL,source_event_name TEXT NOT NULL,
   records INTEGER NOT NULL,source_events INTEGER NOT NULL,payload_bytes INTEGER NOT NULL,
   PRIMARY KEY(day,device_key,tier,source_event_name));
   CREATE TABLE IF NOT EXISTS analytics_diagnostic_usage (
   request_id TEXT NOT NULL,device_key TEXT NOT NULL,accepted INTEGER NOT NULL,
   PRIMARY KEY(request_id,device_key));`);
}
export function authorizeDiagnostic(statements:AnalyticsStore['ingest'],context:AnalyticsDeviceContext,event:AnalyticsEvent,now:number):RejectReason|null{
 const id=event.context.request_id as string,grant=context.diagnosticRequests?.find(g=>g.id===id);
 if(!grant||grant.sn!==context.subject||grant.created_at_ms>now)return 'diagnostic_request_invalid';
 if(grant.revoked_at_ms!==null)return 'diagnostic_request_revoked';
 if(grant.expires_at_ms<=now)return 'diagnostic_request_expired';
 if(!grant.allowed_event_names.includes(event.properties.source_event_name as string))return 'diagnostic_source_not_allowed';
 const source=event.properties.source_occurred_at_ms as number,cutoff=now-grant.lookback_days*86400000;
 if(event.occurred_at_ms<cutoff||event.occurred_at_ms>now+300000||source<cutoff||source>event.occurred_at_ms+300000)return 'diagnostic_sample_stale';
 const used=Number(statements.diagnosticUsed.get(id,context.deviceKey)?.accepted??0);
 if(used>=grant.max_events)return 'diagnostic_request_limit';
 statements.diagnosticUse.run(id,context.deviceKey);
 return null;
}
/** Caller already owns the maintenance transaction; the budget covers both payload tiers. */
export function pruneAnalyticsTiers(db:DatabaseSync,now:number,budget:number){
 let removed=0;
 for(const tier of ['diagnostic','aggregate'] as const){
  if(removed>=budget)break;
  removed+=Number(db.prepare('DELETE FROM analytics_tier_event WHERE rowid IN (SELECT rowid FROM analytics_tier_event WHERE tier=? AND received_at_ms<? LIMIT ?)').run(tier,now-TIER_RETENTION_DAYS[tier]*86_400_000,budget-removed).changes);
 }
 const day=new Date(now-(TIER_RETENTION_DAYS.statistics*86_400_000)+8*3_600_000).toISOString().slice(0,10);
 db.prepare('DELETE FROM analytics_tier_day WHERE rowid IN (SELECT rowid FROM analytics_tier_day WHERE day<? LIMIT ?)').run(day,budget);
 return removed;
}
