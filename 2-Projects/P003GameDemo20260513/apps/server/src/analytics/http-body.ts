import {createGunzip} from 'node:zlib';
import {LIMITS} from './contracts.js';

export class AnalyticsBodyError extends Error {
  constructor(readonly code:string,readonly status:400|413|415|503){super(code);}
}
/** Called only after authentication/admission and reserving one of the two HTTP slots.
 * Both wire and inflated bodies are capped at 2 MiB. zlib runs asynchronously;
 * no unbounded buffering, decompression queue, or synchronous gunzip on the HTTP loop. */
export async function readAnalyticsBody(request:Request,timeoutMs=15_000){
  const encoding=(request.headers.get('Content-Encoding')??'identity').trim().toLowerCase();
  if(encoding!=='identity'&&encoding!=='gzip')throw new AnalyticsBodyError('UNSUPPORTED_CONTENT_ENCODING',415);
  const declared=request.headers.get('Content-Length');
  if(declared!==null&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))))throw new AnalyticsBodyError('INVALID_CONTENT_LENGTH',400);
  if(Number(declared)>LIMITS.bodyBytes)throw new AnalyticsBodyError('ANALYTICS_BODY_TOO_LARGE',413);
  if(!request.body)throw new AnalyticsBodyError('INVALID_BATCH',400);
  const reader=request.body.getReader();let decoder:ReturnType<typeof createGunzip>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
    const error=new AnalyticsBodyError('ANALYTICS_BODY_TIMEOUT',503);
    reject(error);void reader.cancel().catch(()=>{});decoder?.destroy(error);
  },timeoutMs);});
  try{
    const chunks:Uint8Array[]=[];let wireBytes=0;
    while(true){
      const {value,done}=await Promise.race([reader.read(),timeout]);if(done)break;
      wireBytes+=value.byteLength;if(wireBytes>LIMITS.bodyBytes)throw new AnalyticsBodyError('ANALYTICS_BODY_TOO_LARGE',413);
      chunks.push(value);
    }
    let body:Buffer=Buffer.concat(chunks,wireBytes);
    if(encoding==='gzip')body=await Promise.race([new Promise<Buffer>((resolve,reject)=>{
      decoder=createGunzip({chunkSize:16*1024});let bytes=0;const inflated:Buffer[]=[];
      decoder.on('data',(chunk:Buffer)=>{
        bytes+=chunk.length;
        if(bytes>LIMITS.bodyBytes){decoder!.destroy(new AnalyticsBodyError('ANALYTICS_BODY_TOO_LARGE',413));return;}
        inflated.push(chunk);
      });
      decoder.once('error',e=>reject(e instanceof AnalyticsBodyError?e:new AnalyticsBodyError('INVALID_GZIP',400)));
      decoder.once('end',()=>resolve(Buffer.concat(inflated,bytes)));
      decoder.end(body);
    }),timeout]);
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new AnalyticsBodyError('INVALID_JSON',400);}
    return {text,encoding:encoding as 'identity'|'gzip',wireBytes,inflatedBytes:body.length};
  }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});decoder?.destroy();}
}
