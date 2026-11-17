/** Opt-in isolated-test tracing. Logs statement text/hash, never bound values. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
type Sample={id:string;started_at_ms:number;statements:any[];omitted:number};
export function sqlProfiler(databases:{name:string;db:DatabaseSync}[],emit:(sample:any)=>void){
 const context=new AsyncLocalStorage<Sample>();
 const io=()=>{if(process.platform!=='linux')return null;try{
  const values=Object.fromEntries(readFileSync(`/proc/self/task/${process.pid}/io`,'utf8').trim().split('\n').map(line=>line.split(':').map(x=>x.trim())));
  return {read_bytes:Number(values.read_bytes),read_calls:Number(values.syscr)};
 }catch{return null;}};
 function measured<T>(database:string,phase:string,sql:string,operation:()=>T):T{
  const current=context.getStore();if(!current)return operation();
  const beforeIo=io(),start=performance.now(),at=Date.now(),cpu=process.threadCpuUsage();let error:string|null=null;
  try{return operation();}catch(e){error=String((e as any)?.code??'ERROR');throw e;}finally{
   const used=process.threadCpuUsage(cpu),wall=performance.now()-start,afterIo=io();
   if(current.statements.length<64)current.statements.push({database,phase,sql_hash:createHash('sha256').update(sql).digest('hex'),sql:sql.replace(/\s+/g,' ').slice(0,180),started_at_ms:at,wall_ms:wall,thread_cpu_ms:(used.user+used.system)/1000,thread_read_bytes:beforeIo&&afterIo?afterIo.read_bytes-beforeIo.read_bytes:null,thread_read_calls:beforeIo&&afterIo?afterIo.read_calls-beforeIo.read_calls:null,error});else current.omitted++;
  }
 }
 for(const {name,db}of databases){
  const prepare=db.prepare.bind(db),exec=db.exec.bind(db);
  db.prepare=(sql:string)=>{
   const statement=measured(name,'prepare',sql,()=>prepare(sql));
   for(const method of ['get','all','run']as const){const operation=(statement[method]as any).bind(statement);(statement as any)[method]=(...args:any[])=>measured(name,method,sql,()=>operation(...args));}
   return statement;
  };
  db.exec=(sql:string)=>measured(name,'exec',sql,()=>exec(sql));
 }
 return {run:async<T>(id:string,operation:()=>Promise<T>)=>{
  const sample:Sample={id,started_at_ms:Date.now(),statements:[],omitted:0},start=performance.now(),cpu=process.threadCpuUsage();
  try{return await context.run(sample,operation);}finally{const used=process.threadCpuUsage(cpu);emit({...sample,finished_at_ms:Date.now(),wall_ms:performance.now()-start,main_thread_cpu_during_request_ms:(used.user+used.system)/1000});}
 }};
}
