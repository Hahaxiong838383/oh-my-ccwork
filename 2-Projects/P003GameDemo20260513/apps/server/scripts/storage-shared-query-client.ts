import {fork} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function startSharedQuery(root:string,url:string,secret:string){
 const child=fork(fileURLToPath(new URL('./storage-shared-query-service.ts',import.meta.url)),[root],{execArgv:['--max-old-space-size=128','--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
 child.stdout?.on('data',x=>appendFileSync(join(root,'shared-query.stdout'),x));child.stderr?.on('data',x=>appendFileSync(join(root,'shared-query.stderr'),x));
 const pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();let sequence=0,stopping=false,unexpectedExit:Error|undefined;
 const wait=(id:string)=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('query IPC deadline '+id));child.kill('SIGTERM');},60000);pending.set(id,{resolve,reject,timer});});
 child.on('message',(m:any)=>{const p=pending.get(m?.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m);});
 const fail=(e:Error)=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();};
 child.on('error',fail);const exited=new Promise<{code:number|null;signal:string|null}>(resolve=>child.once('exit',(code,signal)=>{
  const error=Error('query service exited '+code+'/'+signal);if(!stopping)unexpectedExit=error;fail(error);resolve({code,signal});
 }));
 const call=async(type:string,extra:object={})=>{if(!child.connected)throw Error('query service disconnected');const id=String(++sequence),answer=wait(id);child.send({id,type,...extra},error=>{if(error)fail(error);});return answer;};
 try{await wait('boot');await call('configure',{url,secret});}catch(error){child.kill('SIGTERM');throw error;}
 return {child,query:async(name:string)=>(await call('query',{name})).exit as number,stop:async()=>{
  if(unexpectedExit)throw unexpectedExit;stopping=true;
  try{await call('stop');const result=await exited;if(result.code!==0||result.signal)throw Error('query service shutdown failed');}catch(error){child.kill('SIGTERM');throw error;}
 }};
}
