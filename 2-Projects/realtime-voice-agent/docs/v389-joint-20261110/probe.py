import asyncio,array,datetime,hashlib,json,os,pathlib,re,struct,subprocess,sys,time,uuid,wave
from livekit import api,rtc
sys.path.insert(0,'/opt/p003-search-verification-20261026')
from rtc_probe_exit import ProbeCompletion,run_disposable_probe
ROOT=pathlib.Path(os.environ['P003_TEST_DIR'])
POOL,CASE,FIXTURE=sys.argv[1:4];PROB=0.0
UNIT='isolated-private';pid=os.environ['P003_TEST_WORKER_PID'];expected=os.environ['P003_TEST_SHA'];EXPECTED={POOL:expected}
e=dict(os.fsdecode(x).split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
assert e['LIVEKIT_URL']=='ws://127.0.0.1:17980'
assert hashlib.sha256(pathlib.Path('/proc',pid,'exe').read_bytes()).hexdigest()==expected
window=None;sn='BJP00326111099999993';runid=CASE;D=ROOT;roomname=f'sn-{sn}-{int(time.time()*1000)}';trace='server-v389-'+str(uuid.uuid4());session=str(uuid.uuid4())
meta={'trace_id':trace,'session_id':session,'issue_ts_ms':int(time.time()*1000),'input_mode':'ordered_pcm','oneshot_first_turn':'v1','local_receipt':'v1','diagnostic_test':'v389-'+CASE,'filler_policy':{'version':1,'style':'chatty','probability':0.0}}
agent=e['AGENT_NAME'];identity='dev-'+sn
wav=pathlib.Path('/root/p003-voice-ab-20261106')/(FIXTURE+'.wav')
with wave.open(str(wav),'rb')as w:
 assert (w.getframerate(),w.getnchannels(),w.getsampwidth())==(16000,1,2);pcm=w.readframes(w.getnframes())
result={'run_id':runid,'pool':POOL,'case':CASE,'fixture':FIXTURE,'wav_sha256':hashlib.sha256(wav.read_bytes()).hexdigest(),'worker_pid':pid,'probe_sha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'helper_sha256':hashlib.sha256(pathlib.Path('/opt/p003-search-verification-20261026/rtc_probe_exit.py').read_bytes()).hexdigest(),'binary_sha256':EXPECTED[POOL],'agent':agent,'room':roomname,'trace':trace,'session':session,'start_ms':int(time.time()*1000),'synthetic':True,'filler_policy':meta['filler_policy'],'chunk_pacing_ms':40,'device_session_api':False,'android':False,'generations':[],'errors':[]}
def now():return int(time.time()*1000)
def log(g,typ,**kw):g['events'].append({'at_ms':now(),'type':typ,**kw})
class Gen:
 def __init__(self,num,subscribe=True):
  self.g={'generation':num,'events':[],'audio_tracks':{},'captions':[],'controls':[],'ordered':[],'metrics':[]};result['generations'].append(self.g)
  self.room=rtc.Room();self.src=None;self.tasks=[];self.streams=[];self.lastvoice=0;self.voiced=0;self.closing=False;self.close_completed=False;self.rooms_connected=0;self.rooms_disconnected=0;self.streams_closed=0;self.sources_closed=0;self.closed_streams=set();self.subscribe=subscribe
  @self.room.on('data_received')
  def data(p):
   try:
    if p.topic=='p003.audio.history.v1':
     hlen=struct.unpack('>HH',p.data[4:8])[1];v=json.loads(p.data[8:8+hlen]);self.g['ordered'].append({'at_ms':now(),'participant_sid':str(p.participant.sid)if p.participant else None,**v});return
    v=json.loads(p.data)
    if p.topic=='control':self.g['controls'].append({'at_ms':now(),'participant_sid':str(p.participant.sid)if p.participant else None,**v})
    if p.topic=='metrics':self.g['metrics'].append({'at_ms':now(),**v})
   except Exception:log(self.g,'parse_error',topic=p.topic)
  @self.room.on('transcription_received')
  def captions(segs,p,publication):
   for s in segs:
    if s.final:self.g['captions'].append({'at_ms':now(),'role':'agent'if p and str(p.identity).startswith('agent-')else'user','text_sha256':hashlib.sha256(s.text.encode()).hexdigest(),'chars':len(s.text),'track_sid':str(publication.sid)if publication else None})
  @self.room.on('track_subscribed')
  def subscribed(track,pub,p):
   log(self.g,'track_subscribed',track_sid=str(pub.sid),participant_sid=str(p.sid),identity=str(p.identity))
   if not self.closing and track.kind==rtc.TrackKind.KIND_AUDIO:self.tasks.append(asyncio.create_task(self.pull(track,str(pub.sid))))
  @self.room.on('track_published')
  def published(pub,p):log(self.g,'track_published',track_sid=str(pub.sid),participant_sid=str(p.sid))
  @self.room.on('participant_connected')
  def connected(p):log(self.g,'participant_connected',participant_sid=str(p.sid),identity=str(p.identity))
  @self.room.on('disconnected')
  def disconnected(reason):log(self.g,'disconnected',reason=str(reason))
  @self.room.on('reconnecting')
  def reconnecting():log(self.g,'reconnecting')
  @self.room.on('reconnected')
  def reconnected():log(self.g,'reconnected')
 async def pull(self,track,sid):
  stream=rtc.AudioStream(track,sample_rate=24000,num_channels=1);self.streams.append(stream)
  stat={'frames':0,'samples':0,'voiced_ms':0,'max_peak':0,'voice_times_ms':[]};self.g['audio_tracks'][sid]=stat;audio=bytearray()
  try:
   async for ev in stream:
    raw=bytes(ev.frame.data);x=array.array('h',raw);peak=max(map(abs,x),default=0);mean=sum(map(abs,x))/max(1,len(x));dur=1000*ev.frame.samples_per_channel/ev.frame.sample_rate
    stat['frames']+=1;stat['samples']+=len(x);stat['max_peak']=max(stat['max_peak'],peak);audio.extend(raw)
    if mean>200:
     self.voiced+=dur;stat['voiced_ms']+=dur;stat['voice_times_ms'].append(now());self.lastvoice=time.monotonic();self.g.setdefault('first_voice_ms',now())
  finally:
   with wave.open(str(D/(f'g{self.g["generation"]}-{sid}.wav')),'wb')as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(audio)
 async def pump(self):
  frame=rtc.AudioFrame(bytes(640),16000,1,320);deadline=time.monotonic()
  while not self.closing:
   await self.src.capture_frame(frame);deadline+=.02;await asyncio.sleep(max(0,deadline-time.monotonic()))
 async def start(self,token,publish_mic=True):
  self.g['connect_start_ms']=now();await asyncio.wait_for(self.room.connect(e['LIVEKIT_URL'],token,options=rtc.RoomOptions(auto_subscribe=self.subscribe)),12);self.g['connect_end_ms']=now();self.rooms_connected=1;self.g['room_sid']=await self.room.sid
  if not publish_mic:return
  self.src=rtc.AudioSource(16000,1,queue_size_ms=200);track=rtc.LocalAudioTrack.create_audio_track('server-ab-synthetic',self.src)
  pub=await self.room.local_participant.publish_track(track,rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE,dtx=False));self.g['mic_sid']=str(pub.sid);self.pump_task=asyncio.create_task(self.pump())
 async def wait(self,pred,sec,why):
  deadline=time.monotonic()+sec
  while not pred():
   if time.monotonic()>deadline:raise AssertionError(why)
   await asyncio.sleep(.025)
 def has(self,t,reason=None):return any(x.get('type')==t and(reason is None or x.get('payload',{}).get('reason')==reason)for x in self.g['controls'])
 async def ordered_send(self):
  base={'input_id':str(uuid.uuid4()),'trace_id':trace,'session_id':session,'capture_epoch':self.g['generation'],'wake_generation':1,'keep_from':0,'boundary_kind':'kws_tail','overlaps_local_playback':False,'sr':16000,'ch':1,'fmt':'s16le','local_receipt':False}
  async def send(t,seq,a,b,body=b''):
   h={**base,'t':t,'seq':seq,'start':a,'end':b,'sent_at_ms':now()};raw=json.dumps(h).encode();await self.room.local_participant.publish_data(b'OPCM'+struct.pack('>HH',1,len(raw))+raw+body,reliable=True,topic='p003.audio.history.v1')
  self.g['input_begin_ms']=now();await send('begin',0,0,0);n=len(pcm)//2;seq=0;pacing_start=time.monotonic()
  for i in range(0,n,640):
   end=min(i+640,n);await send('chunk',seq,i,end,pcm[i*2:end*2]);seq+=1;await asyncio.sleep(max(0,pacing_start+end/16000-time.monotonic()))
  await send('end',seq,n,n);self.g['input_end_ms']=now()
 async def rtc_speak(self):
  self.pump_task.cancel();await asyncio.gather(self.pump_task,return_exceptions=True);await self.src.wait_for_playout();self.g['rtc_input_start_ms']=now()
  for i in range(0,len(pcm),640):await self.src.capture_frame(rtc.AudioFrame(pcm[i:i+640].ljust(640,b'\0'),16000,1,320))
  await self.src.wait_for_playout();self.g['rtc_input_end_ms']=now();self.pump_task=asyncio.create_task(self.pump())
 def playout_proof(self):
  raw=(D/'worker.log').read_text(errors='replace');proofs=[]
  for msg in raw.splitlines():
   msg=re.sub(r'\x1b\[[0-9;]*m','',msg)
   if 'playout metrics'not in msg or 'room='+roomname+' 'not in msg:continue
   fields=dict(re.findall(r'(played_frames|underrun_count|underrun_ms|turn_id)=([0-9]+)',msg))
   if 'exit="SourceDrained"'in msg and int(fields.get('played_frames',0))>0:proofs.append({k:int(v)for k,v in fields.items()})
  return proofs
 async def answer(self):
  deadline=time.monotonic()+45
  while time.monotonic()<deadline:
   proof=await asyncio.to_thread(self.playout_proof)
   if proof and self.voiced>=500 and any(x['role']=='agent'for x in self.g['captions'])and self.lastvoice and time.monotonic()-self.lastvoice>1:
    self.g['server_playout_completed']=proof;break
   await asyncio.sleep(.3)
  else:raise AssertionError('body_playout_not_completed')
  assert any(x['role']=='user'for x in self.g['captions']),'no_asr_final';self.g['answer_passed']=True
 async def close(self):
  self.closing=True;errors=[]
  if hasattr(self,'pump_task'):self.pump_task.cancel();await asyncio.gather(self.pump_task,return_exceptions=True)
  for task in self.tasks:task.cancel()
  results=await asyncio.gather(*self.tasks,return_exceptions=True)
  for value in results:
   if isinstance(value,BaseException)and not isinstance(value,asyncio.CancelledError):errors.append(type(value).__name__)
  for stream in self.streams:
   if id(stream)in self.closed_streams:continue
   try:await asyncio.wait_for(stream.aclose(),5);self.streams_closed+=1;self.closed_streams.add(id(stream))
   except Exception as ex:errors.append(type(ex).__name__)
  if self.src and not self.sources_closed:
   try:await asyncio.wait_for(self.src.aclose(),5);self.sources_closed=1
   except Exception as ex:errors.append(type(ex).__name__)
  try:
   await asyncio.wait_for(self.room.disconnect(),10)
   if self.rooms_connected and not self.room.isconnected():self.rooms_disconnected=1
  except Exception as ex:errors.append(type(ex).__name__)
  self.g['end_ms']=now();self.g['voiced_ms']=self.voiced;self.g['is_disconnected']=not self.room.isconnected();self.g['cleanup']={'rooms_connected':self.rooms_connected,'rooms_disconnected':self.rooms_disconnected,'streams_created':len(self.streams),'streams_closed':self.streams_closed,'sources_created':int(self.src is not None),'sources_closed':self.sources_closed,'errors':errors}
  for sid,stat in self.g['audio_tracks'].items():
   ts=stat.pop('voice_times_ms',[])
   if ts:stat['max_voice_gap_ms']=max((b-a for a,b in zip(ts,ts[1:])),default=0)
   path=D/(f'g{self.g["generation"]}-{sid}.wav')
   if path.exists():stat['wav_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
  self.close_completed=not errors and self.rooms_connected==self.rooms_disconnected and len(self.streams)==self.streams_closed and int(self.src is not None)==self.sources_closed
  assert self.close_completed,'cleanup_incomplete'
def worker_log():return re.sub(r'\x1b\[[0-9;]*m','',(D/'worker.log').read_text(errors='replace'))
def gate_fatal(txt):return 'output gate 5s 未就绪(Android 未订阅 agent 轨),fail-closed'in txt and 'pipeline failed → closing job'in txt
def log_stamp(line):return datetime.datetime.fromisoformat(line.split()[0].replace('Z','+00:00')).timestamp()*1000
def token_for(name):return api.AccessToken(e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET']).with_identity(identity).with_name('v389-isolated-sdk').with_grants(api.VideoGrants(room_join=True,room=name,can_publish=True,can_subscribe=True,can_publish_data=True)).with_room_config(api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=agent,metadata=json.dumps(meta))])).with_ttl(datetime.timedelta(minutes=5)).to_jwt()
async def gone(lk,name,sec=12):
 deadline=time.monotonic()+sec
 while (await lk.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms:
  assert time.monotonic()<deadline,'worker_did_not_delete_room'
  await asyncio.sleep(.1)
async def main():
 global roomname,trace,session
 lk=api.LiveKitAPI(e['LIVEKIT_URL'],e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET']);gens=[];owned={roomname};second=None
 async def new_answer():
  global roomname,trace,session
  roomname=f'sn-{sn}-{int(time.time()*1000)}';owned.add(roomname);trace='server-v389-'+str(uuid.uuid4());session=str(uuid.uuid4());meta.update(trace_id=trace,session_id=session,issue_ts_ms=now())
  g=Gen(len(gens)+1);gens.append(g);await g.start(token_for(roomname));await g.wait(lambda:g.has('session.input_ready')and g.has('session.output_ready'),15,'recovery_ready');await g.ordered_send();await g.answer();await g.close();await gone(lk,roomname);result['recovery_passed']=True;return g
 try:
  assert not(await lk.room.list_rooms(api.ListRoomsRequest())).rooms
  g=Gen(1,CASE!='no_subscribe');gens.append(g)
  if CASE=='prestart_replacement':
   await g.start(token_for(roomname),publish_mic=False);await g.wait(lambda:any(x['type']=='track_subscribed'for x in g.g['events']),12,'first_publication');oldtracks={x['track_sid']for x in g.g['events']if x['type']=='track_subscribed'}
   await g.close();g2=Gen(2);gens.append(g2);await g2.start(token_for(roomname));await g2.wait(lambda:g2.has('session.input_ready')and g2.has('session.output_ready'),15,'replacement_ready');newtracks={x['track_sid']for x in g2.g['events']if x['type']=='track_subscribed'}
   assert 'startup participant replacement accepted'in worker_log(),'prestart_replacement_not_accepted'
   assert newtracks and newtracks.isdisjoint(oldtracks),'publication_not_replaced';await g2.ordered_send();await g2.answer();await g2.close();await gone(lk,roomname);result['prestart_device_replacement_passed']=True
  else:
   await g.start(token_for(roomname));await g.wait(lambda:g.has('session.input_ready'),15,'input_ready')
   if CASE=='capacity':
    await g.wait(lambda:g.has('session.output_ready'),12,'holder_output_ready');secondname=f'sn-{sn}-{int(time.time()*1000)+1000}';owned.add(secondname);second=rtc.Room();await second.connect(e['LIVEKIT_URL'],token_for(secondname));await asyncio.sleep(4)
    txt=worker_log();assert 'worker capacity advertised after job status'in txt and re.search(r'active_jobs=1.*available=false',txt),'capacity_unavailable_not_advertised';assert not any('job_assignment_received'in x and 'room='+secondname+' 'in x for x in txt.splitlines()),'capacity_overadmitted'
    result['capacity_no_overadmit']=True;result['capacity_decline_logged']='at full capacity'in txt;await second.disconnect();second=None;await lk.room.delete_room(api.DeleteRoomRequest(room=secondname));await g.close();await gone(lk,roomname)
    result['capacity_release_start_ms']=now();await new_answer();result['capacity_recovery_ready_ms']=next(x['at_ms']for x in gens[-1].g['controls']if x.get('type')=='session.input_ready');assert result['capacity_recovery_ready_ms']-result['capacity_release_start_ms']<12000,'capacity_recovery_delayed'
   elif CASE=='no_subscribe':
    await g.ordered_send();await g.wait(lambda:'tts provider first PCM observed'in worker_log(),20,'no_provider_pcm_for_gate_test');result['no_subscribe_checkpoint']={'at_ms':now(),'output_ready':g.has('session.output_ready'),'voiced_ms':g.voiced,'fatal_already':gate_fatal(worker_log())};assert not g.has('session.output_ready')and g.voiced==0 and not result['no_subscribe_checkpoint']['fatal_already'],'no_subscribe_checkpoint_invalid'
    await g.wait(lambda:any(x['type']=='disconnected'for x in g.g['events']),12,'gate_did_not_disconnect');txt=worker_log();assert gate_fatal(txt),'wrong_close_reason';assert not re.search(r'played_frames=[1-9][0-9]*',txt),'gate_leaked_pcm';assert not g.has('session.output_ready')and g.voiced==0;await g.close();await gone(lk,roomname);first=next(x for x in txt.splitlines()if 'tts provider first PCM observed'in x);fatal=next(x for x in txt.splitlines()if 'output gate 5s 未就绪'in x);result['first_pcm_to_fatal_ms']=round(log_stamp(fatal)-log_stamp(first));assert 4900<=result['first_pcm_to_fatal_ms']<=7000,'gate_deadline_outside_bound';result['output_gate_failure_passed']=True;await new_answer()
   elif CASE=='worker_replacement':
    await g.wait(lambda:g.has('session.output_ready'),12,'old_worker_ready');oldparts=[p for p in g.room.remote_participants.values()if str(p.identity).startswith('agent-')];assert len(oldparts)==1;old=oldparts[0];result['old_worker_participant']=str(old.sid);result['old_tracks']=[x['track_sid']for x in g.g['events']if x['type']=='track_subscribed']
    await lk.room.remove_participant(api.RoomParticipantIdentity(room=roomname,identity=str(old.identity)));await g.wait(lambda:any(x['type']=='disconnected'for x in g.g['events']),12,'old_worker_loss_not_closed');await g.close();await gone(lk,roomname);(D/'replace.request').write_text('closed-room-before-restart')
    deadline=time.monotonic()+20
    while not(D/'replacement.json').exists():
     assert time.monotonic()<deadline,'replacement_controller_timeout';await asyncio.sleep(.1)
    result['replacement_process']=json.loads((D/'replacement.json').read_text());assert result['replacement_process']['old_pid']!=result['replacement_process']['new_pid'];g2=await new_answer();newtracks=list(g2.g['audio_tracks']);assert newtracks and set(newtracks).isdisjoint(result['old_tracks']);result['worker_process_replacement_passed']=True
   else:
    await g.ordered_send();await g.answer();assert g.has('session.output_ready');await g.close();await gone(lk,roomname)
  result['checks_passed']=True
 except Exception as ex:
  result['checks_passed']=False;result['errors'].append({'type':type(ex).__name__,'reason':str(ex)if isinstance(ex,AssertionError)else'<private>'})
 finally:
  if second:await second.disconnect()
  for g in gens:
   if not g.close_completed:
    try:await g.close()
    except Exception as ex:result['errors'].append({'type':type(ex).__name__,'stage':'cleanup'});result['checks_passed']=False
  result['forced_cleanup_rooms']=[]
  try:
   for name in owned:
    rooms=(await lk.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms
    if rooms:await asyncio.sleep(.5);rooms=(await lk.room.list_rooms(api.ListRoomsRequest(names=[name]))).rooms
    if rooms:result['forced_cleanup_rooms'].append(name);await lk.room.delete_room(api.DeleteRoomRequest(room=name))
   result['room_removed']=not(await lk.room.list_rooms(api.ListRoomsRequest())).rooms
  finally:await lk.aclose()
  result['end_ms']=now();(D/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps({'case':CASE,'checks_passed':result.get('checks_passed'),'room_removed':result.get('room_removed'),'errors':result['errors']}),flush=True)
 assert result['checks_passed']and result['room_removed'],'scenario_failed'
 return ProbeCompletion(sum(g.rooms_connected for g in gens),sum(g.rooms_disconnected for g in gens),sum(len(g.streams)for g in gens),sum(g.streams_closed for g in gens),sum(g.src is not None for g in gens),sum(g.sources_closed for g in gens))
os.environ['P003_DISPOSABLE_RTC_PROBE']='1';run_disposable_probe(main,D/'cleanup.json')
