export class ArkHttpError extends Error {constructor(public status:400|408|413,code:string){super(code);}}
/** Bound bytes while reading, and keep the deadline active until the final JSON parse. */
export async function readBoundedJson(input:Request|Response,limit:number,timeoutMs=1000,signal?:AbortSignal):Promise<unknown>{
 if(Number(input.headers.get('content-length'))>limit)throw new ArkHttpError(413,'body_too_large');
 const reader=input.body?.getReader();if(!reader)throw new ArkHttpError(400,'invalid_json');
 let timer:ReturnType<typeof setTimeout>|undefined;
 let rejectAbort:(e:Error)=>void=()=>{};
 const abort=()=>{void reader.cancel().catch(()=>{});rejectAbort(new ArkHttpError(408,'read_timeout'));};
 const timeout=new Promise<never>((_,reject)=>{rejectAbort=reject;timer=setTimeout(abort,timeoutMs);});
 signal?.addEventListener('abort',abort,{once:true});
 try{return await Promise.race([(async()=>{const chunks:Uint8Array[]=[];let bytes=0;
  while(true){if(signal?.aborted)throw new ArkHttpError(408,'read_timeout');const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit){void reader.cancel().catch(()=>{});throw new ArkHttpError(413,'body_too_large');}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new ArkHttpError(400,'invalid_json');}
 })(),timeout]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);reader.releaseLock();}
}
