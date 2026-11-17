import assert from 'node:assert/strict';

/** Test harness observation only. Full evidence goes to the caller's JSONL sink. */
export function createLoadHealthRecorder(persist:(sample:any)=>void, capacity=256){
  assert(Number.isSafeInteger(capacity)&&capacity>0&&capacity<=4096,'invalid health tail capacity');
  const ring:any[]=[];let cursor=0;
  let samples=0,failed=0,first:number|null=null,last:number|null=null;
  let rssMax:number|null=null,walMax:number|null=null,diskMin:number|null=null;
  const statuses:Record<string,number>={};
  const metric=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
  return {
    record(sample:any){
      // A failed evidence write must remain a failure, not count as a recorded sample.
      persist(sample);samples++;
      const at=metric(sample.at);if(first===null&&at!==null)first=at;if(at!==null)last=at;
      const status=Number.isInteger(sample.status)&&sample.status>=100&&sample.status<=599?String(sample.status):'unknown';
      statuses[status]=(statuses[status]??0)+1;
      if(sample.error||sample.status!==200)failed++;
      const rss=metric(sample.rss_bytes),wal=metric(sample.wal_bytes),disk=metric(sample.disk_free_bytes);
      if(rss!==null)rssMax=Math.max(rssMax??rss,rss);
      if(wal!==null)walMax=Math.max(walMax??wal,wal);
      if(disk!==null)diskMin=Math.min(diskMin??disk,disk);
      if(ring.length<capacity)ring.push(sample);else{ring[cursor]=sample;cursor=(cursor+1)%capacity;}
    },
    recent(){return ring.length<capacity?[...ring]:[...ring.slice(cursor),...ring.slice(0,cursor)];},
    summary(){return {samples,retained_samples:ring.length,tail_capacity:capacity,truncated:samples>ring.length,failed_samples:failed,status_counts:{...statuses},first_at_ms:first,last_at_ms:last,rss_peak_bytes:rssMax,wal_peak_bytes:walMax,disk_free_min_bytes:diskMin,raw_file:'health.jsonl',duration_interpretation:'sample timestamps; not continuous uptime or pressure duration'};},
  };
}
