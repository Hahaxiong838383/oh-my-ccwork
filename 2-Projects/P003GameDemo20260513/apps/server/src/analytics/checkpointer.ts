import {spawn,type ChildProcess} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import {ANALYTICS_WAL_MAX_BYTES,validateWalMaxBytes} from './sqlite-policy.mjs';
export type CheckpointResult={ok:true;sqlite_version:string;busy:number;log_frames:number;checkpointed_frames:number;duration_ms:number;reclaimed:boolean;reclaim_busy:boolean};
export class AnalyticsCheckpointer{
 private child:ChildProcess|null=null;private interval?:ReturnType<typeof setInterval>;private deadline?:ReturnType<typeof setTimeout>;private stopped=true;
 private attempted:number|null=null;private completed:number|null=null;private succeeded:number|null=null;private result:CheckpointResult|null=null;
 private error:string|null=null;private failureCount=0;private timeoutCount=0;
 private readonly max:number;private readonly period:number;private readonly timeout:number;private readonly node:string;
 constructor(private readonly path:string,options:{walMaxBytes?:number;intervalMs?:number;timeoutMs?:number;nodePath?:string}={}){
  this.max=validateWalMaxBytes(options.walMaxBytes??ANALYTICS_WAL_MAX_BYTES);this.period=options.intervalMs??10000;this.timeout=options.timeoutMs??5000;this.node=options.nodePath??process.execPath;
  if(!isAbsolute(this.node)||!isAbsolute(path))throw new Error('INVALID_CHECKPOINT_PATH');
  if(!Number.isInteger(this.period)||this.period<100||this.period>10000||!Number.isInteger(this.timeout)||this.timeout<100||this.timeout>5000)throw new Error('INVALID_CHECKPOINT_SCHEDULE');
 }
 start(){if(!this.stopped)return;this.stopped=false;this.run();this.interval=setInterval(()=>this.run(),this.period);}
 private run(){
  if(this.stopped||this.child)return; // One process in flight, never queue overlapping jobs.
  this.attempted=Date.now();let output='',timedOut=false,spawnFailed=false;
  const child=spawn(this.node,['--max-old-space-size=128','--import','tsx',fileURLToPath(new URL('../../scripts/analytics-checkpoint.ts',import.meta.url)),this.path,String(this.max)],{stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,NODE_ENV:'production'}});
  this.child=child;
  child.stdout!.on('data',(data:Buffer)=>{output+=data.toString('utf8');if(Buffer.byteLength(output)>4096){spawnFailed=true;child.kill('SIGKILL');}});
  child.on('error',()=>{spawnFailed=true;});
  this.deadline=setTimeout(()=>{timedOut=true;this.timeoutCount++;child.kill('SIGKILL');},this.timeout);
  child.on('close',(code)=>{
   clearTimeout(this.deadline);this.deadline=undefined;if(this.child===child)this.child=null;
   if(this.stopped)return;
   this.completed=Date.now();
   try{
    if(timedOut||spawnFailed||code!==0)throw new Error('failed');
    const value=JSON.parse(output.trim()) as CheckpointResult;
    if(value.ok!==true||!Number.isInteger(value.busy)||!Number.isInteger(value.log_frames)||!Number.isInteger(value.checkpointed_frames))throw new Error('invalid');
    this.result=value;this.error=null;
    if(value.busy===0&&value.log_frames===value.checkpointed_frames&&!value.reclaim_busy)this.succeeded=this.completed;
   }catch{this.failureCount++;this.error=timedOut?'ANALYTICS_CHECKPOINT_TIMEOUT':'ANALYTICS_CHECKPOINT_FAILED';}
  });
 }
 status(){return {enabled:!this.stopped,running:this.child!==null,worker_pid:this.child?.pid??null,interval_ms:this.period,timeout_ms:this.timeout,last_attempt_ms:this.attempted,last_completed_ms:this.completed,last_success_ms:this.succeeded,last_result:this.result,last_error:this.error,failures:this.failureCount,timeouts:this.timeoutCount,stale:this.succeeded===null||Date.now()-this.succeeded>3*this.period,stalled:this.result!==null&&(this.result.busy!==0||this.result.log_frames!==this.result.checkpointed_frames||this.result.reclaim_busy)};}
 async stop(){
  this.stopped=true;clearInterval(this.interval);this.interval=undefined;clearTimeout(this.deadline);this.deadline=undefined;
  const child=this.child;if(!child)return;
  await new Promise<void>(resolve=>{child.once('close',()=>resolve());child.kill('SIGKILL');});
  if(this.child===child)this.child=null;
 }
}
