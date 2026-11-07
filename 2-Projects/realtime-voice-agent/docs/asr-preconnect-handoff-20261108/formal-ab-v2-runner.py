from pathlib import Path
import os,json,hashlib,subprocess,time,threading,http.server
D=Path('/root/p003-main-asr-preconnect-20261108');SHA='057f19722de3c2711a50ebb88d2768b8ab36111927495eb8efeda2ee286c426d';SN='BJP00326110899999991'
def production():
 out={}
 for u in ['voice-worker-rust','p003-listening-worker','p003-search-worker']:
  v=dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',u,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines());v['sha256']=hashlib.sha256(Path('/proc',v['MainPID'],'exe').read_bytes()).hexdigest();out[u]=v
 return out
before=production();pid=before['voice-worker-rust']['MainPID'];assert before['voice-worker-rust']['sha256']=='ca41b5358ccbe5293221e6aa1b5f395870366ff3e25a99976c5c099ce0678da9'
provider={}
for item in Path('/proc',pid,'environ').read_bytes().split(b'\0'):
 if b'='not in item:continue
 k,v=os.fsdecode(item).split('=',1)
 if k.startswith(('LIVEKIT_','VOLC_','XFYUN_TTS_'))or k in ['TTS_PROVIDER','P003_DEVICE_ASR_HOTWORDS']:provider[k]=v
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  self.rfile.read(int(self.headers.get('content-length','0')))
  out='data: '+json.dumps({'choices':[{'delta':{'content':'天空看起来是蓝色的，因为空气对蓝色光的散射比较明显。'},'finish_reason':None}]},ensure_ascii=False)+'\n\ndata: '+json.dumps({'choices':[{'delta':{},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n'
  data=out.encode();self.send_response(200);self.send_header('content-type','text/event-stream');self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
candidate=D/'worker-main-asr-handoff-057f1972';assert hashlib.sha256(candidate.read_bytes()).hexdigest()==SHA
result={'candidate':'e9806c7f97e98ade57204242058c02a74673f075','formal_sha256':SHA,'production_before':before,'cases':[],'boundary':'isolated formal same bytes; synthetic LLM/SN; actual SFU ASR TTS; not production dispatch or Android'}
try:
 for label,kind,binary,expected in [('v2-old-normal','0',Path('/proc')/pid/'exe',before['voice-worker-rust']['sha256']),('v2-new-normal','0',candidate,SHA),('v2-old-ordered','1',Path('/proc')/pid/'exe',before['voice-worker-rust']['sha256']),('v2-new-ordered','1',candidate,SHA)]:
  folder=D/('formal-v2-isolated-'+str(time.time_ns()));folder.mkdir(mode=0o700)
  env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/root',**provider,'AGENT_NAME':'p003-main-p0-formal-'+str(time.time_ns()),'WORKER_MAX_JOBS':'1','RUST_LOG':'info','AGENT_GREETING_ENABLED':'0','FILLER_ENABLED':'0','VAD_MODEL_PATH':'/opt/p003-listening-p0-v380-session39/silero_vad.onnx','EOT_SOCK':str(folder/'no-eot.sock'),'P003_SEARCH_ENABLED':'0','P003_TTS_CONNECT_RECOVERY_V1':'1','P003_ASR_CONNECT_RECOVERY_V1':'1','P003_ASYNC_DNS_V1':'1','P003_BUSINESS_WATCHDOG_MODE':'enforce','P003_BUSINESS_WATCHDOG_DEVICE_ALLOWLIST':SN,'LLM_BASE_URL':'http://127.0.0.1:'+str(server.server_port)+'/v1','LLM_API_KEY':'synthetic-isolated-only','LLM_MODEL':'synthetic-sky'}
  with (folder/'worker.log').open('w')as log:worker=subprocess.Popen([str(binary)],cwd=folder,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   for _ in range(150):
    assert worker.poll()is None,'isolated worker exited'
    if 'registered worker' in (folder/'worker.log').read_text():break
    time.sleep(.1)
   else:raise RuntimeError('formal isolated registration timeout')
   with (folder/'probe.log').open('w')as log:r=subprocess.run(['/root/voice-venv/bin/python',str(D/'formal-ab-v2-probe.py'),kind],env={'PATH':'/usr/bin:/bin','HOME':'/root','P003_TEST_WORKER_PID':str(worker.pid),'P003_TEST_SHA':expected,'P003_TEST_LABEL':label},stdout=log,stderr=subprocess.STDOUT,timeout=110)
   result['cases'].append({'label':label,'kind':kind,'rc':r.returncode,'folder':str(folder),'result':json.loads((D/(label+'.json')).read_text())})
  finally:
   worker.terminate()
   try:worker.wait(timeout=8)
   except subprocess.TimeoutExpired:worker.kill();worker.wait(timeout=3)
except BaseException as e:result['error']=str(e)[:300]
finally:
 server.shutdown();server.server_close();result['production_after']=production();result['production_unchanged']=result['production_after']==before;result['candidate_passed']=len(result['cases'])==4 and all(v['rc']==0 and v['result']['status']=='FUNCTIONAL_PASS' for v in result['cases'] if v['label'].startswith('v2-new')) and result['production_unchanged'];result['passed']=len(result['cases'])==4 and all(v['rc']==0 and v['result']['status']=='FUNCTIONAL_PASS'for v in result['cases'])and result['production_unchanged'];(D/'FORMAL_AB_V2_RESULT.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
