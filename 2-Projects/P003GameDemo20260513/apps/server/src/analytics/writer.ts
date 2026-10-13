import {Worker} from 'node:worker_threads';
import {isObject,type AnalyticsBatch,type AnalyticsBatchAck} from './contracts.js';
import type {AnalyticsDeviceContext} from './device-context.js';
import {AnalyticsStorageUnavailable} from './store.js';

export class AnalyticsWriterBusy extends Error {
  constructor(){super('ANALYTICS_WRITER_BUSY');}
}

export type AnalyticsWriterOptions={
  /** Constructor-only fault injection; the production entry point always uses the fixed worker. */
  workerUrl?:URL;
  closeTimeoutMs?:number;
  jobTimeoutMs?:number;
};
export type AnalyticsWriterRequest=
  | ({type:'settle';id:number;context:AnalyticsDeviceContext;requestId:string}&(
      {batch:AnalyticsBatch;serializedBatch?:never}|{serializedBatch:string;batch?:never}
    ))
  | {type:'close'};
type Pending={
  id:number;requestId:string;expectedIds:Set<string>;settled:boolean;
  resolve:(ack:AnalyticsBatchAck)=>void;reject:(error:AnalyticsStorageUnavailable)=>void;
  timer?:ReturnType<typeof setTimeout>;
};
const rejectionReasons=new Set(['event_not_allowed','event_too_large','invalid_event','invalid_context','invalid_properties','client_event_id_conflict']);

function validAck(value:unknown,pending:Pending):value is AnalyticsBatchAck {
  if(!isObject(value)||value.ok!==true||value.request_id!==pending.requestId||value.retry_after_ms!==0||!Array.isArray(value.accepted_event_ids)||!Array.isArray(value.duplicated_event_ids)||!Array.isArray(value.rejected))return false;
  const remaining=new Set(pending.expectedIds);
  for(const id of [...value.accepted_event_ids,...value.duplicated_event_ids])if(typeof id!=='string'||!remaining.delete(id))return false;
  for(const item of value.rejected)if(!isObject(item)||typeof item.client_event_id!=='string'||typeof item.reason!=='string'||!rejectionReasons.has(item.reason)||!remaining.delete(item.client_event_id))return false;
  return remaining.size===0;
}
function timeoutOption(value:number|undefined,fallback:number):number {
  // Test constructors may shorten deadlines; callers cannot exceed the deployment's drain/proxy budget.
  const result=value??fallback;
  if(!Number.isInteger(result)||result<1||result>fallback)throw new RangeError('INVALID_ANALYTICS_WRITER_TIMEOUT');
  return result;
}

/** A single durable writer. The pending slot is occupied synchronously; there is no job queue. */
export class AnalyticsWriter {
  private worker?:Worker;
  private receivedReady=false;
  private failed=false;
  private closing=false;
  private exited=false;
  private cleanExit=false;
  private closeSent=false;
  private closedReply=false;
  private nextId=0;
  private pending?:Pending;
  private closePromise?:Promise<void>;
  private closeResolve?:()=>void;
  private closeReject?:(error:AnalyticsStorageUnavailable)=>void;
  private closeTimer?:ReturnType<typeof setTimeout>;
  private closeSettled=false;
  private readonly closeTimeoutMs:number;
  private readonly jobTimeoutMs:number;

  constructor(path:string,options:AnalyticsWriterOptions={}) {
    this.closeTimeoutMs=timeoutOption(options.closeTimeoutMs,30_000);
    this.jobTimeoutMs=timeoutOption(options.jobTimeoutMs,8_000);
    try{
      this.worker=new Worker(options.workerUrl??new URL('./writer-bootstrap.mjs',import.meta.url),{
        workerData:{path},name:'p003-analytics-writer',execArgv:[],env:{NODE_ENV:'production'},
      });
      this.worker.on('message',(message:unknown)=>this.onMessage(message));
      this.worker.on('error',()=>this.fail());
      this.worker.on('messageerror',()=>this.fail());
      this.worker.on('exit',code=>this.onExit(code));
    }catch{
      this.failed=true;this.exited=true;
    }
  }

  get ready():boolean{return this.receivedReady&&!this.failed&&!this.closing&&!this.exited;}
  /** Remains true after a deadline until the real worker operation ends. */
  get busy():boolean{return this.pending!==undefined;}

  settle(context:AnalyticsDeviceContext,batch:AnalyticsBatch,requestId:string,serializedBatch?:string):Promise<AnalyticsBatchAck> {
    if(!this.ready)return Promise.reject(new AnalyticsStorageUnavailable());
    if(this.pending)return Promise.reject(new AnalyticsWriterBusy());
    return new Promise((resolve,reject)=>{
      let expectedIds:Set<string>;
      try{
        expectedIds=new Set(batch.events.map(event=>{
          if(!isObject(event)||typeof event.client_event_id!=='string')throw new Error();
          return event.client_event_id;
        }));
      }catch{reject(new AnalyticsStorageUnavailable());return;}
      const pending:Pending={id:++this.nextId,requestId,expectedIds,settled:false,resolve,reject};
      this.pending=pending;
      pending.timer=setTimeout(()=>{
        if(this.pending!==pending)return;
        this.failed=true;
        this.rejectPending(false);
        // A timed-out commit has an unknown outcome. Drain it without terminating or replaying it.
        void this.close().catch(()=>{});
      },this.jobTimeoutMs);
      try{
        const {deviceKey,active,uploadEnabled,uploadHourCst}=context;
        // HTTP supplies its original, bounded JSON text: neither stringify nor structuredClone
        // may walk an arbitrarily deep event before the iterative per-event rejection logic.
        const payload=serializedBatch===undefined?{batch}:{serializedBatch};
        this.worker!.postMessage({type:'settle',id:pending.id,context:{deviceKey,active,uploadEnabled,uploadHourCst},...payload,requestId} satisfies AnalyticsWriterRequest);
      }catch{
        // structuredClone failed before submission; the healthy worker and its slot remain reusable.
        this.rejectPending(true);
      }
    });
  }

  close():Promise<void> {
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    this.closePromise=new Promise((resolve,reject)=>{this.closeResolve=resolve;this.closeReject=reject;});
    this.closeTimer=setTimeout(()=>{
      this.failed=true;
      this.rejectPending(false);
      this.finishClose(false);
    },this.closeTimeoutMs);
    if(this.exited)this.finishClose(this.cleanExit);
    else this.sendCloseIfIdle();
    return this.closePromise;
  }

  private rejectPending(clear:boolean,busy=false):void {
    const pending=this.pending;
    if(!pending)return;
    clearTimeout(pending.timer);
    if(!pending.settled){pending.settled=true;pending.reject(new AnalyticsStorageUnavailable(busy));}
    if(clear)this.pending=undefined;
  }

  private onMessage(message:unknown):void {
    if(!isObject(message)||typeof message.type!=='string'){this.fail();return;}
    if(message.type==='ready'){
      if(this.receivedReady||this.exited){this.fail();return;}
      this.receivedReady=true;
      if(this.closing)this.sendCloseIfIdle();
      return;
    }
    if(message.type==='result'){
      const pending=this.pending;
      if(!pending||message.id!==pending.id||typeof message.ok!=='boolean'||(message.ok?!validAck(message.ack,pending):typeof message.busy!=='boolean')){this.fail();return;}
      clearTimeout(pending.timer);
      this.pending=undefined;
      if(!pending.settled){
        pending.settled=true;
        if(message.ok)pending.resolve(message.ack as AnalyticsBatchAck);
        else pending.reject(new AnalyticsStorageUnavailable(message.busy as boolean));
      }
      // A deadline may already have rejected this promise. Late ACKs only release resources.
      if(this.closing)this.sendCloseIfIdle();
      return;
    }
    if(message.type==='closed'){
      if(!this.closing||!this.closeSent||this.pending||this.closedReply){this.fail();return;}
      this.closedReply=true;
      return; // Wait for exit as well, so close means there is no live writer left.
    }
    this.fail();
  }

  private sendCloseIfIdle():void {
    if(this.pending||this.closeSent||this.exited)return;
    this.closeSent=true;
    try{this.worker!.postMessage({type:'close'} satisfies AnalyticsWriterRequest);}
    catch{this.failed=true;this.finishClose(false);}
  }

  private fail():void {
    this.failed=true;
    this.rejectPending(true);
    // No forced terminate: a protocol failure must not interrupt a possibly executing commit.
    void this.close().catch(()=>{});
    this.sendCloseIfIdle();
  }

  private onExit(code:number):void {
    this.exited=true;
    this.cleanExit=code===0&&this.closing&&this.closedReply&&!this.pending;
    if(!this.cleanExit)this.failed=true;
    this.rejectPending(true);
    void this.close().catch(()=>{});
    this.finishClose(this.cleanExit);
  }

  private finishClose(success:boolean):void {
    if(this.closeSettled)return;
    this.closeSettled=true;
    clearTimeout(this.closeTimer);
    if(success)this.closeResolve?.();else this.closeReject?.(new AnalyticsStorageUnavailable());
  }
}
