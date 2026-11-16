import {readStoragePolicy,readVerifiedProfile,type StoragePolicyV1,type VerifiedProfile} from '../storage/policy.js';
import {PRUNE_CYCLE} from './rollup.js';
import {statfsSync,statSync} from 'node:fs';
import type {AnalyticsStore} from './store.js';
import {cstDay,DAY_MS} from './store.js';

export type CapacitySample={free_bytes:number;total_bytes:number;db_bytes:number;wal_bytes:number;daily_peak:number;sample_devices:number;maintenance_ok:boolean;checked_at_ms:number};
/** T4 measured 90-day fixture including indexes: raw+settlement 2093.9B/event.
 * Round raw up to 2304B; two facts measured 961.85B, seen 373.97B.
 * two fact dimensions <1024B/event; permanent seen <400B/event. 10% headroom.
 * Permanent dedup grows without a TTL. Forecast 30/90/180 further days.
 * This planning window does not shorten raw/fact/seen retention. */
export function capacityForecast(s:CapacitySample,controls={policy:readStoragePolicy(null),profile:readVerifiedProfile(null)}){
  const {policy,profile}=controls;
  if(Object.values(s).some(v=>typeof v==='number'&&(!Number.isFinite(v)||v<0)))throw new Error('CAPACITY_UNAVAILABLE');
  const daily=Math.ceil(Math.max(6000,s.daily_peak)/1000)*1000;
  const reserve=4*1024**3,walReserve=512*1024**2;
  const horizon=180,rawDays=14,factDays=90,arkSpoolReserve=policy.spool_limit_bytes;
  // Before T6 proves old keep2 removal: archive mode may retain live + old keep2
  // + last acknowledged payload + next snapshot. Never credit future cleanup.
  const copies=5; // Ark archive_enabled is not the Analytics backup timer state.
  const projections=[30,90,180].map(days=>({horizon_days:days,raw_growth_days:Math.min(14,days),fact_growth_days:Math.min(90,days),seen_growth_days:days,
    bytes_per_device:Math.ceil(daily*(Math.min(14,days)*2304+Math.min(90,days)*1024+days*400)*1.1)*copies}));
  // Four legacy copies; five during archive transition until old backups are retired.
  const perDevice=projections[2].bytes_per_device;
  // Existing files remain occupied; do not count reusable/free pages as extra disk.
  const budget=Math.max(0,s.free_bytes-reserve-walReserve-arkSpoolReserve);
  const storageLimit=Math.floor(budget/perDevice);
  // Scheduled budget is not load verification. Separate profile still caps admissions.
  const maintenanceLimit=Math.floor(PRUNE_CYCLE.maxChunks*PRUNE_CYCLE.chunk*288/2*.7/daily);
  const safeLimit=s.maintenance_ok?Math.max(0,Math.min(storageLimit,maintenanceLimit,profile.analytics_devices,policy.target_devices)):0;
  return {ok:true,...s,projections:projections.map(p=>({...p,target_devices_bytes:p.bytes_per_device*policy.target_devices})),ark_spool_reserve_bytes:arkSpoolReserve,horizon_days:horizon,raw_growth_days:rawDays,fact_growth_days:factDays,seen_growth_days:horizon,daily_events_per_device:daily,raw_retention_days:14,fact_retention_days:90,seen_retention:'persistent',backup_peak_copies:copies,legacy_backup_peak_copies:4,seen_daily_growth_bytes_per_device:Math.ceil(daily*400*1.1)*copies,reserve_bytes:reserve,wal_reserve_bytes:walReserve,budget_bytes:budget,bytes_per_device:perDevice,storage_limit:storageLimit,maintenance_limit:maintenanceLimit,storage_policy_revision:policy.revision,target_devices:policy.target_devices,target_devices_bytes:policy.target_devices*perDevice,target_devices_fit:safeLimit>=policy.target_devices,validated_device_limit:profile.analytics_devices,validation_evidence:profile.evidence,limiting_factors:[...(!s.maintenance_ok?['maintenance_unhealthy']:[]),...(storageLimit<policy.target_devices?['cloud_disk']:[]),...(maintenanceLimit<policy.target_devices?['maintenance_throughput']:[]),...(profile.analytics_devices<policy.target_devices?['not_validated']:[])],max_enabled_devices:safeLimit,twenty_devices_bytes:20*perDevice,twenty_devices_fit:safeLimit>=20,model:'20261116-v3-180d-migration-peak' ,sample_warning:s.sample_devices<3?'单设备样本，按峰值及最低6000条/日保守估算':null};
}
export function capacityReader(store:AnalyticsStore,controls:()=>{policy:StoragePolicyV1;profile:VerifiedProfile}=()=>({policy:readStoragePolicy(null),profile:readVerifiedProfile(null)})){
  let cached:CapacitySample|undefined;
  return ()=>{
    const now=Date.now(),current=controls();if(cached&&now-cached.checked_at_ms<60_000)return capacityForecast(cached,current);
    const fs=statfsSync(store.path),after=cstDay(now-13*DAY_MS);
    const daily=store.db.prepare("SELECT max(event_count) peak,count(DISTINCT device_key) devices FROM analytics_device_day WHERE dimension='occurred' AND day>=?").get(after) as {peak:number|null;devices:number};
    const meta=Object.fromEntries((store.db.prepare('SELECT key,value FROM analytics_meta').all() as {key:string;value:string}[]).map(x=>[x.key,x.value]));
    const last=Number(meta.last_rollup_success_ms)||0;
    cached={free_bytes:Number(fs.bavail)*Number(fs.bsize),total_bytes:Number(fs.blocks)*Number(fs.bsize),db_bytes:statSync(store.path).size,wal_bytes:store.walBytes(),daily_peak:daily.peak??0,sample_devices:daily.devices,maintenance_ok:last>now-30*60_000&&meta.last_rollup_status==='complete'&&Number(meta.last_rollup_remaining_dirty_days??0)===0,checked_at_ms:now};
    return capacityForecast(cached,current);
  };
}
