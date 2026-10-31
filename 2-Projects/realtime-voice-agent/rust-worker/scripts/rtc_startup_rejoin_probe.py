"""Synthetic startup duplicate-identity regression; no real-device token or data."""
import asyncio,datetime,json,os,time,wave,sys,threading,subprocess,re,hashlib
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from livekit import api,rtc
R=Path('/opt/p003-rtc-rejoin-verify-20261031')
for l in (R/'verify.env').read_text().splitlines():
 k,v=l.split('=',1);os.environ[k]=json.loads(v)
MODE=sys.argv[1];LABEL=sys.argv[2];SN='BJP00399999999999871';AGENT=os.environ['AGENT_NAME'];assert AGENT=='p003-rtc-rejoin-verify-20261031','isolated verification agent required'
class Mock(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length','0')))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  for content in ['你好，我听见你的声音了。','小猫晒太阳时会觉得很舒服。']:
   self.wfile.write(('data: '+json.dumps({'choices':[{'delta':{'content':content}}]},ensure_ascii=False)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n')
async def main():
 server=ThreadingHTTPServer(('127.0.0.1',19361),Mock);threading.Thread(target=server.serve_forever,daemon=True).start()
 name=f'sn-{SN}-{int(time.time()*1000)}';trace='rtc-rejoin-'+LABEL+'-'+MODE;meta={'trace_id':trace,'session_id':trace,'issue_ts_ms':int(time.time()*1000)}
 tasks=[];streams=[];rooms=[];src=None;events=[];t0=time.monotonic()
 def token(identity):return (api.AccessToken(os.environ['LIVEKIT_API_KEY'],os.environ['LIVEKIT_API_SECRET']).with_identity(identity).with_grants(api.VideoGrants(room_join=True,room=name,can_publish=True,can_subscribe=True,can_publish_data=True)).with_room_config(api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=AGENT,metadata=json.dumps(meta))])).with_ttl(datetime.timedelta(minutes=5)).to_jwt())
 async def join(identity,label):
  room=rtc.Room();rooms.append(room);counts={'input_ready':0,'output_ready':0,'agent_transcripts':0,'user_transcripts':0,'metrics':0,'voiced_ms':0};disconnect=asyncio.Event()
  @room.on('disconnected')
  def disc(reason):events.append({'event':'disconnected','client':label,'reason':str(reason),'ms':round((time.monotonic()-t0)*1000)});disconnect.set()
  @room.on('transcription_received')
  def text(segments,p,pub):
   if p:counts['user_transcripts'if p.identity==identity else'agent_transcripts']+=sum(s.final for s in segments)
  @room.on('data_received')
  def data(pkt):
   if pkt.topic=='metrics':counts['metrics']+=1
   if pkt.topic=='control':
    try:
     kind=json.loads(pkt.data).get('type');key={'session.input_ready':'input_ready','session.output_ready':'output_ready'}.get(kind)
     if key:counts[key]+=1
    except Exception:pass
  async def consume(track):
   stream=rtc.AudioStream(track);streams.append(stream)
   async for ev in stream:
    a=ev.frame.data
    if len(a)and sum(abs(x)for x in a)/len(a)>180:counts['voiced_ms']+=1000*ev.frame.samples_per_channel/ev.frame.sample_rate
  @room.on('track_subscribed')
  def track(t,pub,p):
   if t.kind==rtc.TrackKind.KIND_AUDIO:tasks.append(asyncio.create_task(consume(t)))
  await room.connect(os.environ['LIVEKIT_URL'],token(identity));events.append({'event':'connected','client':label,'sid':room.local_participant.sid,'ms':round((time.monotonic()-t0)*1000)})
  return room,counts,disconnect
 worker_pid=subprocess.check_output(['systemctl','show','p003-rtc-rejoin-verify','-p','MainPID','--value'],text=True).strip()
 result={'worker_sha256':hashlib.sha256(Path('/proc',worker_pid,'exe').read_bytes()).hexdigest()};epoch_start=time.time()
 try:
  first,fc,fd=await join('dev-'+SN,'old')
  # The observed incident had no microphone; wait for the actual agent connection.
  for _ in range(100):
   if any(p.identity.startswith('agent-')for p in first.remote_participants.values()):break
   await asyncio.sleep(.1)
  assert any(p.identity.startswith('agent-')for p in first.remote_participants.values()),'agent missing'
  async with api.LiveKitAPI(os.environ['LIVEKIT_URL'],os.environ['LIVEKIT_API_KEY'],os.environ['LIVEKIT_API_SECRET'])as client:
   initial_sid=(await client.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms[0].sid
  if MODE=='no_mic_timeout':
   await asyncio.wait_for(fd.wait(),65);result['bounded_no_mic_close']=True
  elif MODE=='depart':
   await first.disconnect();await asyncio.sleep(9);result['departed']=True
  else:
   await asyncio.sleep(3.7)
   if MODE=='foreign':
    visitor,_,_=await join('observer','foreign');await visitor.disconnect();await asyncio.sleep(2)
    assert not fd.is_set(),'foreign participant deleted device room';second,counts,disconnected=first,fc,fd
   else:
    second,counts,disconnected=await join('dev-'+SN,'replacement')
    await asyncio.wait_for(fd.wait(),5)
    if LABEL=='baseline':
     async with api.LiveKitAPI(os.environ['LIVEKIT_URL'],os.environ['LIVEKIT_API_KEY'],os.environ['LIVEKIT_API_SECRET'])as client:
      current=(await client.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms
     result['initial_room_sid']=initial_sid;result['replacement_room_sid']=current[0].sid if current else None
     assert not current or current[0].sid!=initial_sid,'old room was not deleted'
     result['bug_reproduced_room_deleted_and_sdk_recreated']=True
     result['counts']=counts;await second.disconnect();await asyncio.sleep(5)
    else:
     await asyncio.sleep(.3);assert not disconnected.is_set(),'replacement kicked'
     async with api.LiveKitAPI(os.environ['LIVEKIT_URL'],os.environ['LIVEKIT_API_KEY'],os.environ['LIVEKIT_API_SECRET'])as client:
      current=(await client.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms
     assert len(current)==1 and current[0].sid==initial_sid,'room was silently recreated by SDK'
     result['same_room_sid_preserved']=True
   if LABEL!='baseline':
    if MODE=='triple':
     await asyncio.sleep(2);previous=disconnected
     second,counts,disconnected=await join('dev-'+SN,'third');await asyncio.wait_for(previous.wait(),5)
     async with api.LiveKitAPI(os.environ['LIVEKIT_URL'],os.environ['LIVEKIT_API_KEY'],os.environ['LIVEKIT_API_SECRET'])as client:
      current=(await client.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms
     assert len(current)==1 and current[0].sid==initial_sid,'third connection recreated room'
     result['second_replacement_preserved_room']=True
    if MODE=='replacement_no_mic':
     await asyncio.wait_for(disconnected.wait(),13);result['bounded_replacement_no_mic_close']=True
    else:
     src=rtc.AudioSource(24000,1)
     await second.local_participant.publish_track(rtc.LocalAudioTrack.create_audio_track('synthetic-mic',src),rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
     async def silence(sec):
      for _ in range(round(sec*50)):
       assert not disconnected.is_set(),'device disconnected during recovery'
       await src.capture_frame(rtc.AudioFrame(bytes(960),24000,1,480));await asyncio.sleep(.02)
     for _ in range(30):
      if counts['input_ready']and counts['output_ready']:break
      await silence(.2)
     assert counts['input_ready']and counts['output_ready'],('readiness',counts)
     wav=Path('/opt/p003-search-canary-20261021/probe-r5/normal0.wav');assert wav.exists()
     with wave.open(str(wav),'rb')as w:assert w.getframerate()==24000;pcm=w.readframes(w.getnframes())
     for i in range(0,len(pcm),960):
      await src.capture_frame(rtc.AudioFrame(pcm[i:i+960].ljust(960,b'\0'),24000,1,480));await asyncio.sleep(.02)
     await silence(13)
     assert counts['voiced_ms']>500 and counts['user_transcripts']>0 and counts['agent_transcripts']>0 and counts['metrics']>0,counts
     result['audio_subtitles_metrics_pass']=True;result['counts']=counts
     await second.disconnect();await asyncio.sleep(5)
  # Room deletion must still happen when the real participant finally leaves.
  async with api.LiveKitAPI(os.environ['LIVEKIT_URL'],os.environ['LIVEKIT_API_KEY'],os.environ['LIVEKIT_API_SECRET'])as client:
   listed=await client.room.list_rooms(api.ListRoomsRequest(names=[name]));result['room_cleaned']=not listed.rooms
  if LABEL!='baseline':assert result['room_cleaned'],'room leaked'
  await asyncio.sleep(.5)
  logs=subprocess.check_output(['journalctl','-u','p003-rtc-rejoin-verify','--since','@'+str(int(epoch_start)),'-o','json','--no-pager'],text=True)
  lines=[]
  for l in logs.splitlines():
   j=json.loads(l);m=j.get('MESSAGE','');m=bytes(m).decode(errors='replace')if isinstance(m,list)else m
   if name in m:lines.append(re.sub(r'\x1b\[[0-9;]*m','',m))
  jobs=sum('job_assignment_received'in m for m in lines);closed=sum('job closed'in m for m in lines)
  result['job_assignments']=jobs;result['job_closed']=closed;result['asr_retry_count']=sum('asr 断线重连'in m for m in lines)
  closed_at=next((i for i,m in enumerate(lines)if 'job closed'in m),len(lines))
  result['asr_retries_after_job_closed']=sum('asr 断线重连'in m for m in lines[closed_at:])
  if LABEL!='baseline':
   assert jobs==1 and closed==1,('job lifecycle',jobs,closed)
   assert result['asr_retries_after_job_closed']==0,'ASR retry after job closed'
   if MODE in ['duplicate','foreign','depart']:assert result['asr_retry_count']==0,('ASR retry leak',result['asr_retry_count'])
  result.update(mode=MODE,label=LABEL,room=name,synthetic=True,real_device_speaker_verified=False,events=events,elapsed_s=round(time.monotonic()-t0,2));(R/(LABEL+'-'+MODE+'.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
 finally:
  (R/(LABEL+'-'+MODE+'-partial.json')).write_text(json.dumps({**result,'room':name,'events':events},indent=2))
  for room in rooms:
   if room.isconnected():await room.disconnect()
  for task in tasks:task.cancel()
  await asyncio.gather(*tasks,return_exceptions=True)
  for stream in streams:await stream.aclose()
  if src:await src.aclose()
  async with api.LiveKitAPI(os.environ['LIVEKIT_URL'],os.environ['LIVEKIT_API_KEY'],os.environ['LIVEKIT_API_SECRET'])as client:
   try:await client.room.delete_room(api.DeleteRoomRequest(room=name))
   except Exception:pass
  server.shutdown()
asyncio.run(main())
