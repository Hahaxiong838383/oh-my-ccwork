import {Worker} from 'node:worker_threads';
export function startArkProducer(config:{root:string;url:string;brainPid:number;tokens:string[];startedMs:number;durationMs:number;intervalMs:number},onRound:(rounds:number)=>void){
 const stop=new Int32Array(new SharedArrayBuffer(4));
 const worker=new Worker(new URL('./storage-ark-producer.mjs',import.meta.url),{workerData:{...config,stop:stop.buffer},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:32},name:'t5-device-http-producer'});
 let done=false;
 const promise=new Promise<void>((resolve,reject)=>{
  worker.on('message',m=>{if(m?.type==='round')onRound(m.rounds);else if(m?.type==='done')done=true;});
  worker.on('error',reject);worker.on('exit',code=>{if(code===0&&done)resolve();else reject(Error('Ark producer exited '+code+' without complete evidence'));});
 });
 return {promise,stop:()=>{Atomics.store(stop,0,1);}};
}
