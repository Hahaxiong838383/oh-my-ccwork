from pathlib import Path
import re,os,json,hashlib,subprocess,time,threading,http.server,socket,secrets,signal
os.umask(0o077)
def on_term(signum,frame):raise SystemExit('bounded test interrupted')
signal.signal(signal.SIGTERM,on_term)
D=Path('/root/p003-v389-voice-recovery-joint-20261110');R=D/('isolated-'+str(time.time_ns()));R.mkdir(mode=0o700)
EXPECTED={'voice-worker-rust':'8a9534897303b8f12406df47a51bf70dba8d26ef44efd56e27db4601f5ea50a9','p003-listening-worker':'517f5290eeb73486ccb3bcf86e16eec24bde5b6380d825851592c1f308f5f305'}
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def production():
 out={}
 for u in ['voice-worker-rust','p003-listening-worker','p003-search-worker']:
  v=dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',u,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines());v['sha256']=sha(Path('/proc',v['MainPID'],'exe'));out[u]=v
 return out
before=production();result={'started_ms':int(time.time()*1000),'folder':str(R),'production_before':before,'cases':[],'boundary':'private loopback SFU; same production Worker bytes; synthetic identity+LLM; actual ASR/TTS; SDK, not Android; no production service/config/room changed'}
for u,want in EXPECTED.items():assert before[u]['sha256']==want,'runtime drift'
(R/'PRODUCTION_BASELINE.json').write_text(json.dumps(before))
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  self.rfile.read(int(self.headers.get('content-length','0')))
  s='data: '+json.dumps({'choices':[{'delta':{'content':'天空是蓝色的，因为空气对蓝色光的散射比较明显。'},'finish_reason':None}]},ensure_ascii=False)+'\n\ndata: '+json.dumps({'choices':[{'delta':{},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n'
  b=s.encode();self.send_response(200);self.send_header('content-type','text/event-stream');self.send_header('content-length',str(len(b)));self.end_headers();self.wfile.write(b)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
sfu_bin=Path('/root/p003-main-dns-hedge-20261108/formal-v3/livekit-server.isolated');assert sha(sfu_bin)=='15cef609925237efc8d8b305b9aca9ca3827a006314de26fa14075d6f60ab86b'
key='v389-private';secret=secrets.token_hex(32);config={'port':17980,'bind_addresses':['127.0.0.1'],'rtc':{'tcp_port':17981,'udp_port':17982,'node_ip':'127.0.0.1','use_external_ip':False,'enable_loopback_candidate':True,'interfaces':{'includes':['lo']}},'keys':{key:secret},'logging':{'level':'warn'}}
(R/'sfu.json').write_text(json.dumps(config));workers=[];sfu=None
try:
 for port in [17980,17981]:
  with socket.socket()as sock:sock.bind(('127.0.0.1',port))
 with(R/'sfu.log').open('w')as f:sfu=subprocess.Popen([str(sfu_bin),'--config',str(R/'sfu.json')],stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
 for _ in range(100):
  assert sfu.poll()is None,'sfu exited'
  try:
   with socket.create_connection(('127.0.0.1',17980),timeout=.2):break
  except OSError:time.sleep(.1)
 else:raise AssertionError('sfu startup timeout')
 cases=[('main','normal'),('main','capacity'),('main','no_subscribe'),('main','prestart_replacement'),('main','worker_replacement'),('listening','normal'),('listening','no_subscribe')]
 selected=os.environ.get('P003_CASE_FILTER','').split(',')
 if selected!=['']:cases=[x for x in cases if x[0]+'-'+x[1]in selected]
 for pool,case in cases:
  assert production()==before,'production drift';label=pool+'-'+case;folder=R/label;folder.mkdir(mode=0o700);unit='voice-worker-rust'if pool=='main'else'p003-listening-worker';pid=before[unit]['MainPID'];provider={}
  for item in Path('/proc',pid,'environ').read_bytes().split(b'\0'):
   if b'='not in item:continue
   k,v=os.fsdecode(item).split('=',1)
   if k.startswith(('VOLC_','XFYUN_TTS_'))or k in ['TTS_PROVIDER','P003_DEVICE_ASR_HOTWORDS']:provider[k]=v
  env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/root',**provider,'LIVEKIT_URL':'ws://127.0.0.1:17980','LIVEKIT_API_KEY':key,'LIVEKIT_API_SECRET':secret,'AGENT_NAME':'v389-isolated-'+pool,'WORKER_MAX_JOBS':'1','RUST_LOG':'info','AGENT_GREETING_ENABLED':'0','FILLER_ENABLED':'0','VAD_MODEL_PATH':'/opt/p003-listening-p0-v380-session39/silero_vad.onnx','EOT_SOCK':str(folder/'absent.sock'),'P003_SEARCH_ENABLED':'0','P003_TTS_CONNECT_RECOVERY_V1':'1','P003_ASR_CONNECT_RECOVERY_V1':'1','P003_ASYNC_DNS_V1':'1','P003_TTS_DNS_HEDGE_V1':'1','P003_BUSINESS_WATCHDOG_MODE':'observe','LLM_BASE_URL':'http://127.0.0.1:'+str(server.server_port)+'/v1','LLM_API_KEY':'synthetic-private-only','LLM_MODEL':'synthetic'}
  binary=Path('/proc',pid,'exe')
  def launch():
   with(folder/'worker.log').open('a')as f:w=subprocess.Popen([str(binary)],cwd=folder,env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
   workers.append(w);return w
  w=launch()
  try:
   for _ in range(200):
    assert w.poll()is None,'isolated worker exited before registered'
    if 'registered worker'in(folder/'worker.log').read_text():break
    time.sleep(.1)
   else:raise AssertionError('register timeout')
   assert sha(Path('/proc',str(w.pid),'exe'))==EXPECTED[unit]
   with(folder/'probe.log').open('w')as log:p=subprocess.Popen(['/root/voice-venv/bin/python',str(D/'probe.py'),pool,case,'normal-short'],env={'PATH':'/usr/bin:/bin','HOME':'/root','P003_TEST_DIR':str(folder),'P003_TEST_WORKER_PID':str(w.pid),'P003_TEST_SHA':EXPECTED[unit]},stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   deadline=time.monotonic()+140;replaced=False
   while p.poll()is None:
    if case=='worker_replacement'and(folder/'replace.request').exists()and not replaced:
     oldpid=w.pid;w.terminate();w.wait(timeout=8);count=(folder/'worker.log').read_text().count('registered worker');w=launch()
     for _ in range(150):
      assert w.poll()is None
      if(folder/'worker.log').read_text().count('registered worker')>count:break
      time.sleep(.1)
     else:raise AssertionError('replacement registration timeout')
     assert sha(Path('/proc',str(w.pid),'exe'))==EXPECTED[unit];(folder/'replacement.json').write_text(json.dumps({'old_pid':oldpid,'new_pid':w.pid,'sha256':EXPECTED[unit]}));replaced=True
    if time.monotonic()>deadline:p.terminate();p.wait(timeout=8);raise AssertionError('probe timeout')
    time.sleep(.15)
   body=json.loads((folder/'result.json').read_text())if(folder/'result.json').exists()else None
   r={'pool':pool,'case':case,'rc':p.returncode,'folder':str(folder),'passed':p.returncode==0 and body is not None and body.get('checks_passed')and body.get('room_removed'),'errors':body.get('errors')if body else ['no_result'],'binary_sha256':EXPECTED[unit],'probe_sha256':sha(D/'probe.py'),'worker_log_sha256':sha(folder/'worker.log'),'result_sha256':sha(folder/'result.json')if body else None}
   result['cases'].append(r);(D/'ISOLATED_PROGRESS.json').write_text(json.dumps(result,indent=2));assert r['passed'],'case failed: '+label
  finally:
   if 'p'in locals()and p.poll()is None:p.terminate();p.wait(timeout=8)
   if w.poll()is None:w.terminate();w.wait(timeout=8)
except BaseException as ex:result['error']=str(ex)if isinstance(ex,AssertionError)else type(ex).__name__
finally:
 for w in workers:
  if w.poll()is None:w.kill();w.wait(timeout=3)
 if sfu and sfu.poll()is None:sfu.terminate();sfu.wait(timeout=10)
 server.shutdown();server.server_close();result['production_after']=production();result['production_unchanged']=result['production_after']==before;result['isolated_processes_stopped']=all(w.poll()is not None for w in workers)and(sfu is None or sfu.poll()is not None);result['passed']=len(result['cases'])==len(cases) and all(x['passed']for x in result['cases'])and result['production_unchanged']and result['isolated_processes_stopped'];result['ended_ms']=int(time.time()*1000);(D/'ISOLATED_RESULT.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
raise SystemExit(0 if result['passed']else 1)
