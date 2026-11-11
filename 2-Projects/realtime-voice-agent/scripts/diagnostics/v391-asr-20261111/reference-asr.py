# Minimal independent wire implementation; no transcript or credential output.
import asyncio,os,json,uuid,gzip,struct,time,wave,hashlib
import websockets
async def main():
 e=os.environ;rid=str(uuid.uuid4());header={'X-Api-Resource-Id':e.get('VOLC_ASR_RESOURCE_ID','volc.bigasr.sauc.duration'),'X-Api-Request-Id':rid,'X-Api-Connect-Id':str(uuid.uuid4())}
 if e.get('VOLC_ASR_API_KEY'):header['X-Api-Key']=e['VOLC_ASR_API_KEY']
 else:header.update({'X-Api-App-Id':e['VOLC_APP_ID'],'X-Api-App-Key':e['VOLC_APP_ID'],'X-Api-Access-Key':e['VOLC_ACCESS_TOKEN']})
 with wave.open(e['P003_SYNTHETIC_ASR_WAV'],'rb')as w:assert(w.getframerate(),w.getnchannels(),w.getsampwidth())==(16000,1,2);pcm=w.readframes(w.getnframes())+bytes(64000)
 init={'user':{'uid':rid},'audio':{'format':'pcm','codec':'raw','rate':16000,'bits':16,'channel':1},'request':{'model_name':'bigmodel','enable_itn':True,'enable_punc':True,'enable_ddc':e.get('VOLC_ASR_ENABLE_DDC','1')=='1','show_utterances':True,'enable_nonstream':False,'end_window_size':int(e.get('VOLC_ASR_END_WINDOW_MS','800'))}}
 def frame(typ,flag,seq,b):
  z=gzip.compress(b);return bytes([0x11,typ<<4|flag,0x11,0])+struct.pack('>iI',seq,len(z))+z
 result={'request_id':rid,'written_samples':0,'binary':0,'empty':0,'text_present':0,'definite':0,'last':False,'elapsed_ms':0};start=time.monotonic()
 async with websockets.connect('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',additional_headers=header,open_timeout=10,ping_interval=20,proxy=None)as ws:
  await ws.send(frame(1,1,1,json.dumps(init).encode()))
  async def send():
   t=time.monotonic();seq=1
   for i in range(0,len(pcm),6400):
    await asyncio.sleep(max(0,t+i/32000-time.monotonic()));seq+=1;part=pcm[i:i+6400];await ws.send(frame(2,1,seq,part));result['written_samples']+=len(part)//2
   await ws.send(frame(2,3,-seq-1,b''))
  sender=asyncio.create_task(send())
  try:
   async with asyncio.timeout(25):
    async for raw in ws:
     if not isinstance(raw,bytes):continue
     result['binary']+=1;typ=raw[1]>>4;flag=raw[1]&15;off=(raw[0]&15)*4
     if typ==15:result['error_code']=struct.unpack_from('>I',raw,off)[0];raise AssertionError('provider_error')
     if flag&1:off+=4
     n=struct.unpack_from('>I',raw,off)[0];body=raw[off+4:off+4+n]
     if raw[2]&15==1:body=gzip.decompress(body)
     if typ==9:
      r=json.loads(body).get('result',{});us=r.get('utterances',[]);result['empty']+=int(not us);result['text_present']+=int(bool(r.get('text')));result['definite']=max(result['definite'],sum(u.get('definite')is True and bool(u.get('text'))for u in us))
      if flag&2:result['last']=True;break
  finally:sender.cancel();await asyncio.gather(sender,return_exceptions=True)
 result['elapsed_ms']=round((time.monotonic()-start)*1000);print(json.dumps(result));assert result['last']and result['definite']>0
asyncio.run(main())
