import pathlib,subprocess,json,time,hashlib,os,re,importlib.util,datetime
D=pathlib.Path('/root/p003-business-watchdog-20261107/probe-cleanup-v2-20261108');BASE=D.parent;unit='voice-worker-rust.service';want='3dd0430aaf97d3ef5d056d871f3d87a64c66508c0b9b8cf9702bc9f0e73e70cb'
def state(**kw):(D/'status.json').write_text(json.dumps({'runner_pid':os.getpid(),'at':time.time(),**kw}))
def preflight():
 pid=subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip();assert pid=='3512437';assert hashlib.sha256(pathlib.Path('/proc',pid,'exe').read_bytes()).hexdigest()==want
 env=dict(os.fsdecode(x).split('=',1)for x in pathlib.Path('/proc',pid,'environ').read_bytes().split(b'\0')if b'='in x)
 spec=importlib.util.spec_from_file_location('c','/opt/p003-business-cleanup/reconcile_rooms.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);api=m.RoomAPI(env['LIVEKIT_URL'],env['LIVEKIT_API_KEY'],env['LIVEKIT_API_SECRET']);assert not api.post('ListRooms',{}).get('rooms',[]),'active room: stop batch'
results=[]
try:
 for i in range(3):
  if i:
   until=time.time()+35
   while time.time()<until:state(stage='quiet_interval',round=i,until=until,results=results);time.sleep(2)
  preflight();r=D/str(i);r.mkdir();label='release-cleanup-v2-'+str(i)
  s=(D/'probe-template.py').read_text().replace("LABEL='release-dispatch-asr-connect-ordered'+sys.argv[1]",'LABEL='+repr(label));(r/'probe.py').write_text(s)
  f=(r/'capture.log').open('x');cap=subprocess.Popen(['python3',str(D/'dns-meta-trace.py'),'--output',str(r/'capture'),'--seconds','120'],stdout=f,stderr=subprocess.STDOUT)
  state(stage='capture_start',round=i,capture_pid=cap.pid,results=results);started=time.time()
  try:
   for _ in range(30):
    if(r/'capture/ready.json').exists():break
    assert cap.poll()is None;time.sleep(.1)
   assert(r/'capture/ready.json').exists()
   with(r/'probe.log').open('x')as log:
    q=subprocess.Popen(['/root/voice-venv/bin/python',str(r/'probe.py'),str(i%2)],stdout=log,stderr=subprocess.STDOUT)
    while q.poll()is None:
     state(stage='probe',round=i,capture_pid=cap.pid,probe_pid=q.pid,results=results)
     if time.time()-started>110:q.terminate();q.wait(timeout=4);raise TimeoutError('bounded probe')
     time.sleep(1)
   (r/'process.json').write_text(json.dumps({'returncode':q.returncode}));p=BASE/(label+'.json');result=json.loads(p.read_text())if p.exists()else {'status':'NO_RESULT'};(r/'result.json').write_text(json.dumps(result))
   since=datetime.datetime.fromtimestamp(started,datetime.timezone.utc).isoformat();j=subprocess.check_output(['journalctl','-u',unit,'--since',since,'--no-pager','-o','cat'],text=True);j=re.sub(r'\x1b\[[0-9;]*m','',j)
   keys=['tts connection timing','tts connection assigned','tts provider first PCM observed','tts stream timing','tts dispatch timing','tts foreground slow connection','body first sentence ready','playout metrics','asr connection timing','room cleanup readback complete']
   selected=[x for x in j.splitlines()if any(k in x for k in keys)];(r/'timings.json').write_text(json.dumps(selected));slow=[x for x in selected if 'tts connection timing'in x and any(int(n)>=1000 for n in re.findall(r'\bdns_ms=(\d+)',x))]
   results.append({'round':i,'rc':q.returncode,'status':result['status'],'slow_tts_dns':slow});assert q.returncode==0 and result['status']=='FUNCTIONAL_PASS'
   probe_log=(r/'probe.log').read_text()
   assert not any(k in probe_log for k in ['Event loop is closed','panic','Task was destroyed']), 'probe teardown errors'
   results[-1]['status']='PASS_WITH_CLEAN_PROCESS_EXIT'
  finally:cap.terminate();cap.wait(timeout=4);f.close()
  if slow:break
 state(stage='complete',results=results)
 (D/'finished.json').write_text(json.dumps({'at':time.time(),'status':'COMPLETE','results':results}))
except BaseException as e:
 state(stage='failed',error=type(e).__name__,results=results);(D/'finished.json').write_text(json.dumps({'at':time.time(),'status':'FAILED','error':type(e).__name__,'results':results}));raise
