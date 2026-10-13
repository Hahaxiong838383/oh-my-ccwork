import {parentPort,workerData} from 'node:worker_threads';
import {isObject,validateAnalyticsBatch} from './contracts.js';
import {settleAnalyticsBatch} from './ingest.js';
import {AnalyticsStore,AnalyticsStorageUnavailable} from './store.js';
import type {AnalyticsWriterRequest} from './writer.js';

const port=parentPort;
let store:AnalyticsStore|undefined;
let closed=false;
function fatal():void {
  if(closed)return;
  closed=true;
  try{store?.close();}catch{}
  try{port?.postMessage({type:'fatal'});}catch{}
  port?.close();
  process.exitCode=1;
}

try{
  if(!port||!isObject(workerData)||typeof workerData.path!=='string')throw new Error();
  store=new AnalyticsStore(workerData.path);
  // Keep AnalyticsStore's 64MiB pager budget: RSS also includes the HTTP and worker isolates.
  // FULL and wal_autocheckpoint=0 remain configured by AnalyticsStore.
  port.on('message',(raw:unknown)=>{
    if(closed)return;
    if(!isObject(raw)){fatal();return;}
    if(raw.type==='close'){
      try{store!.close();closed=true;port.postMessage({type:'closed'});port.close();}
      catch{fatal();}
      return;
    }
    const hasSerialized=Object.hasOwn(raw,'serializedBatch');
    if(raw.type!=='settle'||!Number.isSafeInteger(raw.id)||typeof raw.requestId!=='string'||!isObject(raw.context)||(hasSerialized?(typeof raw.serializedBatch!=='string'||Object.hasOwn(raw,'batch')):!isObject(raw.batch))){fatal();return;}
    const message=raw as unknown as Extract<AnalyticsWriterRequest,{type:'settle'}>;
    try{
      const batch=validateAnalyticsBatch(typeof message.serializedBatch==='string'?JSON.parse(message.serializedBatch):message.batch);
      // settleAnalyticsBatch only returns after its FULL transaction has committed.
      const ack=settleAnalyticsBatch(store!,message.context,batch,message.requestId);
      port.postMessage({type:'result',id:message.id,ok:true,ack});
    }catch(error){
      try{port.postMessage({type:'result',id:message.id,ok:false,busy:error instanceof AnalyticsStorageUnavailable&&error.busy});}
      catch{fatal();}
    }
  });
  port.on('messageerror',fatal);
  port.postMessage({type:'ready'});
}catch{fatal();}
