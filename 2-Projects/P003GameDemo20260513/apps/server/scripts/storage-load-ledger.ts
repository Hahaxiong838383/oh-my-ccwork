import assert from 'node:assert/strict';
import {createReadStream,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {loadDatabaseCounts} from '../deploy/analytics-smoke-and-load.mjs';

type Shape={devices:number;events:number;batch:number};
type Spec=Shape&{prefix:string};
function shape(s:Shape){assert(Number.isSafeInteger(s.devices)&&s.devices>0&&s.devices<=1000);assert(Number.isSafeInteger(s.events)&&s.events>0&&s.events<=60000);assert(Number.isSafeInteger(s.batch)&&s.batch>0&&s.batch<=200);}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export const deviceKeyForActor=(actor:number)=>digest('BJP003999999'+String(actor+1).padStart(8,'0'));

/** Bounded decoder: do not let corrupt evidence force a whole-file allocation. */
export async function* readJsonl(path:string,maxLineBytes=256*1024):AsyncGenerator<any>{
 let pending='';
 for await(const chunk of createReadStream(path,{encoding:'utf8',highWaterMark:64*1024})){
  pending+=chunk;let at:number;
  while((at=pending.indexOf('\n'))!==-1){const line=pending.slice(0,at);pending=pending.slice(at+1);assert(Buffer.byteLength(line)<=maxLineBytes,'JSONL line limit');assert(line.length>0,'empty JSONL line');yield JSON.parse(line);}
  assert(Buffer.byteLength(pending)<=maxLineBytes,'JSONL line limit');
 }
 assert(pending.length===0,'truncated JSONL evidence');
}

/** O(device count) memory. Exact ID universe follows the generator's canonical IDs. */
export function createStreamingAccounting(s:Spec){
 shape(s);assert.match(s.prefix,/^load-[A-Za-z0-9-]+$/);
 const next=Array(s.devices).fill(0);let accepted=0,duplicated=0,batches=0;
 const totals=()=>({batches,events_accepted:accepted,events_duplicated:duplicated,events_acknowledged:accepted+duplicated,unique_acknowledged_events:next.reduce((a,b)=>a+b,0)});
 return {totals,record(row:{actor:number;offset:number;ack:any}){
  const {actor,offset,ack}=row;assert(Number.isInteger(actor)&&actor>=0&&actor<s.devices,'invalid actor');
  assert(offset===next[actor]&&offset<s.events,'batch order or already acknowledged');
  assert.equal(ack.ok,true);assert.deepEqual(ack.rejected,[],'load ACK rejected');
  const n=Math.min(s.batch,s.events-offset),expected=Array.from({length:n},(_,i)=>s.prefix+'-'+actor+'-'+(offset+i));
  assert(Array.isArray(ack.accepted_event_ids)&&Array.isArray(ack.duplicated_event_ids),'ACK arrays');
  const ids=[...ack.accepted_event_ids,...ack.duplicated_event_ids];
  assert.deepEqual([...ids].sort(),expected.sort(),'ACK partition must exactly match batch');
  assert.equal(new Set(ids).size,n,'ACK partition disjoint');
  next[actor]+=n;accepted+=ack.accepted_event_ids.length;duplicated+=ack.duplicated_event_ids.length;batches++;
 },report(db:DatabaseSync,before:Record<string,number>,failures:unknown[]){
  const expectedEvents=s.devices*s.events,expectedBatches=s.devices*Math.ceil(s.events/s.batch);
  db.exec('BEGIN');try{
   const after=loadDatabaseCounts(db),delta=Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-before[k]]));
   const seen=db.prepare('SELECT 1 present FROM analytics_event_seen WHERE device_key=? AND id_digest=?');
   const keys=Array.from({length:s.devices},(_,i)=>deviceKeyForActor(i));let rows=0,valid=0,seenMatches=0;
   for(const row of db.prepare('SELECT device_key,client_event_id FROM analytics_event WHERE client_event_id GLOB ?').iterate(s.prefix+'-*')){
    rows++;const id=String(row.client_event_id),parts=id.slice(s.prefix.length+1).split('-'),actor=Number(parts[0]),index=Number(parts[1]);
    const canonical=parts.length===2&&Number.isInteger(actor)&&actor>=0&&actor<s.devices&&Number.isInteger(index)&&index>=0&&index<s.events&&id===s.prefix+'-'+actor+'-'+index&&row.device_key===keys[actor];
    if(canonical)valid++;
    if(seen.get(row.device_key,digest(id)))seenMatches++;
   }
   // PK(device_key,id), canonical actor→device key, exact count and ID bounds
   // prove the full unique universe without retaining an event-sized JS Set.
   const exact=rows===expectedEvents&&valid===expectedEvents&&seenMatches===expectedEvents&&delta.events===expectedEvents&&delta.seen===expectedEvents;
   return {...totals(),expected_events:expectedEvents,expected_batches:expectedBatches,counts:after,database_before:before,database_delta:delta,database_run_events:rows,database_canonical_matches:valid,database_seen_matches:seenMatches,database_integrity:exact,complete:exact&&batches===expectedBatches&&next.every(x=>x===s.events)&&accepted+duplicated===expectedEvents&&failures.length===0};
  }finally{db.exec('COMMIT');}
 }};
}

/** Exact percentiles from a separate derived SQLite file, after the load ends. */
export async function analyseRequests(path:string,derivedPath:string,s:Shape){
 shape(s);assert(!existsSync(derivedPath),'never overwrite request analysis');
 const db=new DatabaseSync(derivedPath),next=Array(s.devices).fill(0),tries=Array(s.devices).fill(0);
 let attempts=0,successes=0;const statuses:Record<string,number>={};
 try{
  db.exec('PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; CREATE TABLE latency(ms REAL NOT NULL); BEGIN');
  const insert=db.prepare('INSERT INTO latency(ms) VALUES(?)');
  for await(const r of readJsonl(path)){
   assert(Number.isInteger(r.actor)&&r.actor>=0&&r.actor<s.devices,'request actor');
   assert(r.offset===next[r.actor]&&r.offset<s.events&&r.attempt===tries[r.actor],'request order');
   assert(Number.isInteger(r.status)&&r.status>=0&&r.status<=599,'request status');assert(Number.isFinite(r.ms)&&r.ms>=0,'request latency');
   attempts++;statuses[r.status]=(statuses[r.status]??0)+1;
   if(r.status===200){insert.run(r.ms);successes++;next[r.actor]+=Math.min(s.batch,s.events-r.offset);tries[r.actor]=0;}else tries[r.actor]++;
  }
  db.exec('COMMIT; CREATE INDEX latency_order ON latency(ms)');
  const q=(p:number)=>successes?Number(db.prepare('SELECT ms FROM latency ORDER BY ms LIMIT 1 OFFSET ?').get(Math.min(successes-1,Math.floor(successes*p)))!.ms):null;
  return {attempts,successes,statuses,p95:q(.95),p99:q(.99),all_actors_finished:next.every(x=>x===s.events),raw_file:'requests.jsonl',method:'exact disk ORDER BY, floor(n*p), no exclusions from attempt counts'};
 }finally{db.close();}
}
