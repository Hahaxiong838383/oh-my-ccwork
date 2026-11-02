import type {AnalyticsStore} from './store.js';
import type {DatabaseSync} from 'node:sqlite';
export type AnalyticsTransport={encoding:'identity'|'gzip';wireBytes:number;inflatedBytes:number};
export function initAnalyticsTransport(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_transport (
    attempt_id TEXT PRIMARY KEY,encoding TEXT NOT NULL,wire_bytes INTEGER NOT NULL,inflated_bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS analytics_transport_day (
    day TEXT NOT NULL,device_key TEXT NOT NULL,encoding TEXT NOT NULL,requests INTEGER NOT NULL,
    wire_bytes INTEGER NOT NULL,inflated_bytes INTEGER NOT NULL,PRIMARY KEY(day,device_key,encoding));`);
}
/** Same transaction as the batch ACK; retries count transport traffic, never new events. */
export function recordAnalyticsTransport(statements:AnalyticsStore['ingest'],attempt:string,day:string,deviceKey:string,t?:AnalyticsTransport){
  if(!t)return; // Old direct/offline callers have no measured HTTP bytes: keep unknown.
  if(!['identity','gzip'].includes(t.encoding)||![t.wireBytes,t.inflatedBytes].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2*1024*1024))throw new Error('INVALID_TRANSPORT');
  statements.transport.run(attempt,t.encoding,t.wireBytes,t.inflatedBytes);
  statements.transportDay.run(day,deviceKey,t.encoding,t.wireBytes,t.inflatedBytes);
}
