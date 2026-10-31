import {statfsSync,statSync} from 'node:fs';
import type {AnalyticsStore} from './store.js';
import {cstDay,DAY_MS} from './store.js';

export type CapacitySample={free_bytes:number;total_bytes:number;db_bytes:number;wal_bytes:number;daily_peak:number;sample_devices:number;maintenance_ok:boolean;checked_at_ms:number};
/** Measured inclusive of indexes on 2026-10-31: raw+settlement with new indexes <1280B,
 * two fact dimensions <1024B/event; permanent seen <400B/event. 10% headroom.
 * No promise of bounded lifetime size: seen forecast is a further 90 days. */
export function capacityForecast(s:CapacitySample){
  if(Object.values(s).some(v=>typeof v==='number'&&(!Number.isFinite(v)||v<0)))throw new Error('CAPACITY_UNAVAILABLE');
  const daily=Math.ceil(Math.max(6000,s.daily_peak)/1000)*1000;
  const reserve=4*1024**3,walReserve=512*1024**2;
  // Four copies cover live DB, two retained backups and the next backup before pruning.
  const perDevice=Math.ceil(daily*(14*1280+90*1024+90*400)*1.1)*4;
  // Existing files remain occupied; do not count reusable/free pages as extra disk.
  const budget=Math.max(0,s.free_bytes-reserve-walReserve);
  const storageLimit=Math.floor(budget/perDevice);
  // Fact pruning: 1000 rows/5min, two rows/event; reserve 30% for contention/retries.
  const maintenanceLimit=Math.floor(144000*.7/daily);
  const safeLimit=s.maintenance_ok?Math.max(0,Math.min(storageLimit,maintenanceLimit,20)):0;
  return {ok:true,...s,horizon_days:90,daily_events_per_device:daily,raw_retention_days:14,fact_retention_days:90,seen_retention:'persistent',backup_peak_copies:4,reserve_bytes:reserve,wal_reserve_bytes:walReserve,budget_bytes:budget,bytes_per_device:perDevice,storage_limit:storageLimit,maintenance_limit:maintenanceLimit,validated_device_limit:20,max_enabled_devices:safeLimit,twenty_devices_bytes:20*perDevice,twenty_devices_fit:safeLimit>=20,model:'20261031-v1',sample_warning:s.sample_devices<3?'单设备样本，按峰值及最低6000条/日保守估算':null};
}
export function capacityReader(store:AnalyticsStore){
  let cached:ReturnType<typeof capacityForecast>|undefined;
  return ()=>{
    const now=Date.now();if(cached&&now-cached.checked_at_ms<60_000)return cached;
    const fs=statfsSync(store.path),after=cstDay(now-13*DAY_MS);
    const daily=store.db.prepare("SELECT max(event_count) peak,count(DISTINCT device_key) devices FROM analytics_device_day WHERE dimension='occurred' AND day>=?").get(after) as {peak:number|null;devices:number};
    const meta=Object.fromEntries((store.db.prepare('SELECT key,value FROM analytics_meta').all() as {key:string;value:string}[]).map(x=>[x.key,x.value]));
    const last=Number(meta.last_rollup_success_ms)||0;
    cached=capacityForecast({free_bytes:Number(fs.bavail)*Number(fs.bsize),total_bytes:Number(fs.blocks)*Number(fs.bsize),db_bytes:statSync(store.path).size,wal_bytes:store.walBytes(),daily_peak:daily.peak??0,sample_devices:daily.devices,maintenance_ok:last>now-30*60_000&&meta.last_rollup_status==='complete'&&Number(meta.last_rollup_remaining_dirty_days??0)===0,checked_at_ms:now});
    return cached;
  };
}
