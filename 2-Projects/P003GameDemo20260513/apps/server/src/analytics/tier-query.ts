import type {AnalyticsStore} from './store.js';
import {cstDay,DAY_MS} from './store.js';
import {TIER_RETENTION_DAYS} from './tiers.js';
/** Read bounded daily counters, never expand aggregates into raw events or game facts. */
export function queryAnalyticsTiers(store:AnalyticsStore,deviceKey:string,now=Date.now()){
 const from=cstDay(now-6*DAY_MS),to=cstDay(now),db=store.db;
 return store.readSnapshot(()=>({
  ok:true,from,to,dimension:'received',tracking_scope:'v375_ingest_only',seven_day_savings_verified:false,
  retention_days:TIER_RETENTION_DAYS,seen_retention:'persistent',
  layers:db.prepare(`SELECT tier,source_event_name,sum(records) records,sum(source_events) source_events,sum(payload_bytes) payload_bytes
    FROM analytics_tier_day WHERE day>=? AND day<=? AND device_key=? GROUP BY tier,source_event_name ORDER BY tier,source_event_name`).all(from,to,deviceKey),
  transport:db.prepare('SELECT encoding,sum(requests) requests,sum(wire_bytes) wire_bytes,sum(inflated_bytes) inflated_bytes FROM analytics_transport_day WHERE day>=? AND day<=? AND device_key=? GROUP BY encoding').all(from,to,deviceKey),
  recent:db.prepare(`SELECT client_event_id,event_name,source_event_name,source_event_count,tier,received_at_ms,occurred_at_ms,diagnostic_request_id,properties_json
    FROM analytics_tier_event WHERE device_key=? ORDER BY received_at_ms DESC LIMIT 10`).all(deviceKey).map(({properties_json,...r})=>({...r,properties:JSON.parse(properties_json as string)})),
  request_usage:db.prepare('SELECT request_id,accepted FROM analytics_diagnostic_usage WHERE device_key=? ORDER BY rowid DESC LIMIT 100').all(deviceKey),
 }));
}
