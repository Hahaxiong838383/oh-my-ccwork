import asyncio,array,datetime,hashlib,json,os,pathlib,re,struct,subprocess,sys,time,uuid,wave
from livekit import api,rtc
sys.path.insert(0,'/opt/p003-search-verification-20261026')
from rtc_probe_exit import ProbeCompletion,run_disposable_probe
ROOT=pathlib.Path('/root/p003-voice-ab-20261106')
POOL,CASE,FIXTURE=sys.argv[1:4]
PROB=float(sys.argv[4])if len(sys.argv)>4 else 0.0
assert PROB in [0.0,1.0]
assert POOL in ['main','gray'] and CASE in ['normal','reconnect','no_subscribe','missing_begin','rtc_recovery','prestart','full_recovery']
UNIT='voice-worker-rust' if POOL=='main' else 'p003-listening-worker'
EXPECTED={'main':'f7dfdd4517fc2addb41b393c10f232a19d074e0752c6abb8977e08f11a7b7ed0','gray':'7d39184c200053db5adbc59580517110762b0c3ac31928cc246d5f9162817de0'}
pid=subprocess.check_output(['systemctl','show',UNIT,'-p','MainPID','--value'],text=True).strip()
e=dict(x.decode().split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
assert hashlib.sha256(pathlib.Path('/proc',pid,'exe').read_bytes()).hexdigest()==EXPECTED[POOL],'runtime_drift'
window=json.loads(pathlib.Path(e['P003_SEARCH_CANARY_WINDOW_FILE']).read_text())if POOL=='gray'else None
if window:
 assert window['enabled'] and window['expires_at_ms']>int(time.time()*1000)
 health=json.loads(pathlib.Path(e['P003_SEARCH_CANARY_HEALTH_FILE']).read_text())
 for _ in range(12):
  if health['jobs']==0 and health['registered']:break
  time.sleep(.5);health=json.loads(pathlib.Path(e['P003_SEARCH_CANARY_HEALTH_FILE']).read_text())
 assert health['jobs']==0 and health['registered'],'real_job_active'
sn=window['allowlist'][0] if window else 'BJP00399999999999902'
runid=f'v3-p{int(PROB)}-{POOL}-{CASE}-{FIXTURE}-{int(time.time()*1000)}';D=ROOT/runid;D.mkdir(mode=0o700)
# Distinct synthetic room suffix; never join a real device room. This is NOT a
# device/session-API acceptance test. No Android/analytics events are generated.
roomname=f'sn-{sn}-{int(time.time()*1000)}';trace='server-ab-'+str(uuid.uuid4());session=str(uuid.uuid4())
meta={'trace_id':trace,'session_id':session,'issue_ts_ms':int(time.time()*1000),'input_mode':'ordered_pcm','oneshot_first_turn':'v1','local_receipt':'v1','diagnostic_test':runid,'filler_policy':{'version':1,'style':'chatty','probability':PROB}}
if window:meta['search_canary']={'sn':sn,'expires_at_ms':window['expires_at_ms'],'generation':window['generation']}
agent=e['AGENT_NAME'];identity='dev-'+sn
wav=ROOT/(FIXTURE+'.wav')
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
   if track.kind==rtc.TrackKind.KIND_AUDIO:self.tasks.append(asyncio.create_task(self.pull(track,str(pub.sid))))
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
  raw=subprocess.check_output(['journalctl','-u',UNIT,'--since',f"@{self.g['connect_start_ms']/1000}",'-o','json','--no-pager'],timeout=5)
  proofs=[]
  for line in raw.splitlines():
   j=json.loads(line);msg=j.get('MESSAGE','');msg=bytes(msg).decode('utf8','replace')if isinstance(msg,list)else msg;msg=re.sub(r'\x1b\[[0-9;]*m','',msg)if isinstance(msg,str)else''
   if 'playout metrics'not in msg or 'room='+roomname+' 'not in msg:continue
   fields=dict(re.findall(r'(played_frames|underrun_count|underrun_ms|turn_id)=([0-9]+)',msg))
   if 'exit="SourceDrained"'in msg and int(fields.get('played_frames',0))>0:
    proofs.append({'at_us':int(j['__REALTIME_TIMESTAMP']),'pid':j.get('_PID'),**{k:int(v)for k,v in fields.items()}})
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
  try:
   await asyncio.wait_for(self.room.disconnect(),10)
   if self.rooms_connected and not self.room.isconnected():self.rooms_disconnected=1
  except Exception as ex:errors.append(type(ex).__name__)
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
  self.g['end_ms']=now();self.g['voiced_ms']=self.voiced;self.g['is_disconnected']=not self.room.isconnected();self.g['cleanup']={'rooms_connected':self.rooms_connected,'rooms_disconnected':self.rooms_disconnected,'streams_created':len(self.streams),'streams_closed':self.streams_closed,'sources_created':int(self.src is not None),'sources_closed':self.sources_closed,'errors':errors}
  for sid,stat in self.g['audio_tracks'].items():
   ts=stat.pop('voice_times_ms',[])
   if ts:stat['max_voice_gap_ms']=max((b-a for a,b in zip(ts,ts[1:])),default=0)
   path=D/(f'g{self.g["generation"]}-{sid}.wav')
   if path.exists():stat['wav_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
  self.close_completed=not errors and self.rooms_connected==self.rooms_disconnected and len(self.streams)==self.streams_closed and int(self.src is not None)==self.sources_closed
  assert self.close_completed,'cleanup_incomplete'
async def main():
 lk=api.LiveKitAPI(e['LIVEKIT_URL'],e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET']);gens=[]
 try:
  rooms=await lk.room.list_rooms(api.ListRoomsRequest());assert not any(r.name==roomname for r in rooms.rooms),'room_already_exists'
  if POOL=='gray':assert not any(r.name.startswith('sn-'+sn+'-') for r in rooms.rooms),'real_device_room_active'
  token=api.AccessToken(e['LIVEKIT_API_KEY'],e['LIVEKIT_API_SECRET']).with_identity(identity).with_name('synthetic-server-ab').with_grants(api.VideoGrants(room_join=True,room=roomname,can_publish=True,can_subscribe=True,can_publish_data=True)).with_room_config(api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=agent,metadata=json.dumps(meta))])).with_ttl(datetime.timedelta(minutes=5)).to_jwt()
  if CASE in ['reconnect','full_recovery']:
   first=Gen(1);gens.append(first);await first.start(token);await first.wait(lambda:first.has('session.input_ready')and first.has('session.output_ready'),12,'g1_ready');await first.close()
   deadline=time.monotonic()+8
   while (await lk.room.list_rooms(api.ListRoomsRequest(names=[roomname]))).rooms:
    assert time.monotonic()<deadline,'previous_room_not_removed'
    await asyncio.sleep(.2)
  if CASE=='prestart':
   first=Gen(1);gens.append(first);await first.start(token,publish_mic=False);await first.wait(lambda:any(x['type']=='track_subscribed'for x in first.g['events']),10,'startup_track_not_subscribed');await first.close()
  if CASE=='full_recovery':
   bad=Gen(len(gens)+1,False);gens.append(bad);await bad.start(token);await bad.wait(lambda:bad.has('session.input_ready'),12,'g2_ready');await bad.ordered_send();await bad.wait(lambda:any(x['type']=='disconnected'for x in bad.g['events']),20,'g2_gate_not_closed');assert not bad.has('session.output_ready')and bad.voiced==0;await bad.close()
   deadline=time.monotonic()+8
   while (await lk.room.list_rooms(api.ListRoomsRequest(names=[roomname]))).rooms:
    assert time.monotonic()<deadline,'g2_room_not_removed'
    await asyncio.sleep(.2)
  g=Gen(len(gens)+1,CASE!='no_subscribe');gens.append(g);await g.start(token);await g.wait(lambda:g.has('session.input_ready'),15,'input_ready')
  if CASE in ['normal','reconnect','prestart']:
   await g.ordered_send();await g.answer();assert g.has('session.output_ready'),'output_ready_missing'
  elif CASE=='no_subscribe':
   await g.ordered_send();await g.wait(lambda:any(x['type']=='disconnected'for x in g.g['events']),20,'no_gate_failure_close');assert g.voiced==0 and not g.has('session.output_ready');g.g['expected_negative_passed']=True
  elif CASE in ['missing_begin','rtc_recovery','prestart','full_recovery']:
   await g.wait(lambda:g.has('session.input_phase','begin_timeout'),8,'begin_timeout_missing');assert not any(x['role']=='agent'for x in g.g['captions']);g.g['expected_negative_passed']=True
   if CASE in ['rtc_recovery','full_recovery']:await g.rtc_speak();await g.answer()
  result['checks_passed']=True
 except Exception as ex:
  result['errors'].append({'type':type(ex).__name__,'reason':str(ex)if isinstance(ex,AssertionError)else'<private>'});result['checks_passed']=False
 finally:
  for g in gens:
   if not g.close_completed:
    try:await g.close()
    except Exception as ex:result['errors'].append({'type':type(ex).__name__,'stage':'cleanup'});result['checks_passed']=False
  try:
   rooms=await lk.room.list_rooms(api.ListRoomsRequest(names=[roomname]))
   result['forced_delete']=False
   if rooms.rooms:
    assert str(rooms.rooms[0].sid)in {g.g.get('room_sid')for g in gens},'cleanup_room_sid_changed'
    result['forced_delete']=True;await lk.room.delete_room(api.DeleteRoomRequest(room=roomname))
   rooms=await lk.room.list_rooms(api.ListRoomsRequest(names=[roomname]));result['room_removed']=not rooms.rooms
  finally:await lk.aclose()
  result['end_ms']=now();(D/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps({'dir':str(D),'run_id':runid,'checks_passed':result.get('checks_passed'),'room_removed':result.get('room_removed'),'errors':result['errors']}),flush=True)
 assert result['checks_passed']and result['room_removed'],'scenario_failed'
 return ProbeCompletion(sum(g.rooms_connected for g in gens),sum(g.rooms_disconnected for g in gens),sum(len(g.streams)for g in gens),sum(g.streams_closed for g in gens),sum(g.src is not None for g in gens),sum(g.sources_closed for g in gens))
os.environ['P003_DISPOSABLE_RTC_PROBE']='1';run_disposable_probe(main,D/'cleanup.json')
