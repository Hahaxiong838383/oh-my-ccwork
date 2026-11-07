import asyncio,array,datetime,hashlib,json,os,pathlib,subprocess,sys,time,uuid,wave,fcntl
from livekit import api,rtc
from livekit.rtc._ffi_client import FfiClient
D=pathlib.Path('/root/p003-main-asr-preconnect-20261108');SN='BJP00326110799999901'
SHA='057f19722de3c2711a50ebb88d2768b8ab36111927495eb8efeda2ee286c426d'
ORDERED=sys.argv[1]=='1';LABEL='main-handoff-release-ordered'+sys.argv[1]
def unit():return dict(s.split('=',1)for s in subprocess.check_output(['systemctl','show','voice-worker-rust.service','-p','MainPID','-p','NRestarts','-p','ActiveState'],text=True).splitlines())
before=unit();pid=before['MainPID'];assert hashlib.sha256(pathlib.Path('/proc',pid,'exe').read_bytes()).hexdigest()==SHA
env=dict(os.fsdecode(s).split('=',1)for s in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in s)
assert env.get('P003_ASR_CONNECT_RECOVERY_V1')=='1'
assert env['P003_BUSINESS_WATCHDOG_MODE']=='enforce' and SN in env['P003_BUSINESS_WATCHDOG_DEVICE_ALLOWLIST'].split(',')
lock=(D/'probe.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
assert not(D/(LABEL+'.json')).exists()
WAV=pathlib.Path('/root/p003-voice-ab-20261106/normal-short.wav');assert hashlib.sha256(WAV.read_bytes()).hexdigest()=='9ea46b2c12e570ab71a4b10283c733331d2048331b0b876df47b9a78b10f0b03'
with wave.open(str(WAV),'rb')as f:
 assert (f.getnchannels(),f.getsampwidth(),f.getframerate())==(1,2,16000);pcm=f.readframes(f.getnframes())
async def main():
 started=time.monotonic();trace='ops-release-probe-'+str(uuid.uuid4());name=f'sn-{SN}-{int(time.time()*1000)}';identity='dev-'+SN
 meta={'trace_id':trace,'session_id':trace,'issue_ts_ms':int(time.time()*1000),'voice_idle':{'timeout_ms':5000,'revision':'cfg-900001'},'filler_policy':{'version':1,'style':'chatty','probability':0.0}}
 if ORDERED:meta.update(input_mode='ordered_pcm',oneshot_first_turn='v1')
 token=api.AccessToken(env['LIVEKIT_API_KEY'],env['LIVEKIT_API_SECRET']).with_identity(identity).with_grants(api.VideoGrants(room_join=True,room=name,can_publish=True,can_subscribe=True)).with_room_config(api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name='rust-worker',metadata=json.dumps(meta))])).to_jwt()
 client=api.LiveKitAPI(env['LIVEKIT_URL'].replace('wss:','https:').replace('ws:','http:'),env['LIVEKIT_API_KEY'],env['LIVEKIT_API_SECRET'])
 room=rtc.Room();tasks=[];streams=[];speak=asyncio.Event();disconnected=asyncio.Event();stats={'ready_ms':None,'phase_ms':None,'user_finals':0,'answer_finals':0,'audible_ms':0,'first_audio_ms':None,'last_audio_ms':None,'input_sent_ms':None,'events':[],'metrics_packets':0,'metric_kinds':[],'input_samples_sent':0};sid=None;source=None;natural_gone=False;success=False
 def elapsed():return round((time.monotonic()-started)*1000)
 @room.on('disconnected')
 def gone(*_):disconnected.set()
 @room.on('data_received')
 def data(packet):
  try:v=json.loads(bytes(packet.data))
  except Exception:return
  typ=v.get('type');stats['events'].append(typ)
  if packet.topic=='metrics' and v.get('k'):
   stats['metrics_packets']+=1;stats['metric_kinds'].append(v['k'])
  if v.get('trace_id')!=trace:return
  if typ=='session.input_ready' and stats['ready_ms'] is None:
   stats['ready_ms']=elapsed()
   if not ORDERED:speak.set()
  if typ=='session.input_phase' and v.get('payload',{}).get('reason')=='begin_timeout':stats['phase_ms']=elapsed();speak.set()
 @room.on('transcription_received')
 def transcription(segments,participant,*_):
  for s in segments:
   if s.final and s.text.strip():
    k='user_finals' if participant and participant.identity==identity else 'answer_finals';stats[k]+=1
 @room.on('track_subscribed')
 def subscribed(track,publication,participant):
  if track.kind==rtc.TrackKind.KIND_AUDIO:tasks.append(asyncio.create_task(pull(track)))
 async def pull(track):
  stream=rtc.AudioStream(track);streams.append(stream)
  async for ev in stream:
   f=ev.frame;a=array.array('h',bytes(f.data))
   if a and sum(abs(v)for v in a)//len(a)>200:
    stats['audible_ms']+=1000*len(a)/f.num_channels/f.sample_rate
    if stats['first_audio_ms'] is None:stats['first_audio_ms']=elapsed()
    stats['last_audio_ms']=elapsed()
 async def send(source):
  offset=0
  while not disconnected.is_set():
   b=bytes(320)
   if speak.is_set() and offset<len(pcm):
    if stats['input_sent_ms'] is None:stats['input_sent_ms']=elapsed()
    b=pcm[offset:offset+320].ljust(320,b'\0');stats['input_samples_sent']+=min(320,len(pcm)-offset)//2;offset+=320
   await source.capture_frame(rtc.AudioFrame(b,16000,1,160))
 try:
  await asyncio.wait_for(room.connect(env['LIVEKIT_URL'],token),20)
  stats['client_connected_ms']=elapsed();sid=await room.sid
  await asyncio.sleep(12)
  stats['track_publish_requested_ms']=elapsed()
  source=rtc.AudioSource(16000,1,queue_size_ms=100);track=rtc.LocalAudioTrack.create_audio_track('synthetic-mic',source)
  await room.local_participant.publish_track(track,rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE));tasks.append(asyncio.create_task(send(source)))
  await asyncio.wait_for(disconnected.wait(),75)
  for _ in range(20):
   r=await asyncio.wait_for(client.room.list_rooms(api.ListRoomsRequest(names=[name])),5)
   if not r.rooms:natural_gone=True;break
   await asyncio.sleep(1)
  assert stats['ready_ms'] is not None and stats['user_finals']>0 and stats['answer_finals']>0 and stats['audible_ms']>=500,stats
  assert not ORDERED or stats['phase_ms'] is not None,stats
  assert natural_gone,'room retained'
  assert stats['input_samples_sent']==len(pcm)//2,'input fixture not completely sent'
  assert {'eou','llm','tts'}.issubset(set(stats['metric_kinds'])),'required actual metrics missing'
  assert unit()==before,'production worker changed'
  success=True
 finally:
  for t in tasks:t.cancel()
  await asyncio.gather(*tasks,return_exceptions=True)
  for stream in streams:
   await asyncio.wait_for(stream.aclose(),5)
  await room.disconnect()
  # Installed SDK disconnect() returns early after a remote disconnect. Drain
  # its listener ownership explicitly after remote Gone; no server task is canceled.
  listener=getattr(room,'_task',None)
  assert not room.isconnected(),'room still connected during cleanup'
  if listener is not None:
   listener.cancel()
   await asyncio.gather(listener,return_exceptions=True)
  if getattr(room,'_ffi_handle',None) is not None:
   FfiClient.instance.queue.unsubscribe(room._ffi_queue)
   room._ffi_handle.dispose()
  cleanup=False
  if not natural_gone:
   r=await asyncio.wait_for(client.room.list_rooms(api.ListRoomsRequest(names=[name])),5)
   if r.rooms:
    assert len(r.rooms)==1 and (sid is None or r.rooms[0].sid==sid)
    try:
     await asyncio.wait_for(client.room.delete_room(api.DeleteRoomRequest(room=name)),5);cleanup=True
    except api.TwirpError as error:
     if error.code!='not_found':raise
     remaining=await asyncio.wait_for(client.room.list_rooms(api.ListRoomsRequest(names=[name])),5)
     assert not remaining.rooms,'404 cleanup must be confirmed absent'
     natural_gone=True
  await client.aclose()
  if source is not None:await source.aclose()
  # Every owned SDK producer is now closed. Fail visibly on a dangling queue;
  # do not silence FFI callbacks or bypass interpreter shutdown.
  stats['ffi_subscribers_after_cleanup']=len(FfiClient.instance.queue._subscribers)
  assert stats['ffi_subscribers_after_cleanup']==0,'live FFI queue after cleanup'
  await asyncio.sleep(0.25)
  out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'FUNCTIONAL_PASS'if success else'FAIL','candidate_sha256':SHA,'runtime_pid':pid,'ordered':ORDERED,'trace_id':trace,'room':name,'sid':sid,'stats':stats,'natural_room_gone':natural_gone,'fixture_cleanup':cleanup,'elapsed_ms':elapsed(),'policy_source':'operator-signed synthetic metadata; not device cfg-139','real_android':False}
  (D/(LABEL+'.json')).write_text(json.dumps(out,indent=2));print(json.dumps(out),flush=True)
asyncio.run(main())
