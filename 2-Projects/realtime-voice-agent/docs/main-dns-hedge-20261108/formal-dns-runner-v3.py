from pathlib import Path
import re,os,json,hashlib,subprocess,time,threading,http.server,socket,socketserver,struct,secrets
D=Path('/root/p003-main-dns-hedge-20261108/formal-v3');SN='BJP00326110899999992'
manifest=json.loads((D/'CANDIDATE.json').read_text());SHA=manifest['binary_sha256'];candidate=D/'worker-main-dns-hedge'
OLD='057f19722de3c2711a50ebb88d2768b8ab36111927495eb8efeda2ee286c426d'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def production():
    out={}
    for u in ['voice-worker-rust','p003-listening-worker','p003-search-worker']:
        v=dict(x.split('=',1)for x in subprocess.check_output(['systemctl','show',u,'-p','MainPID,NRestarts,ActiveState'],text=True).splitlines());v['sha256']=sha(Path('/proc',v['MainPID'],'exe'));out[u]=v
    out['stub_sha256']=sha('/run/systemd/resolve/stub-resolv.conf');out['upstream_sha256']=sha('/run/systemd/resolve/resolv.conf');out['host_mnt_namespace']=os.readlink('/proc/self/ns/mnt')
    return out
assert not(D/'FORMAL_DNS_RESULT.json').exists()
before=production();pid=before['voice-worker-rust']['MainPID'];assert before['voice-worker-rust']['sha256']==OLD and sha(candidate)==SHA
provider={}
for item in Path('/proc',pid,'environ').read_bytes().split(b'\0'):
    if b'=' not in item:continue
    k,v=os.fsdecode(item).split('=',1)
    if k.startswith(('LIVEKIT_','VOLC_','XFYUN_TTS_')) or k in ['TTS_PROVIDER','P003_DEVICE_ASR_HOTWORDS']:provider[k]=v
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length','0')))
        s='data: '+json.dumps({'choices':[{'delta':{'content':'天空看起来是蓝色的，因为空气对蓝色光的散射比较明显。'},'finish_reason':None}]},ensure_ascii=False)+'\n\ndata: '+json.dumps({'choices':[{'delta':{},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n'
        b=s.encode();self.send_response(200);self.send_header('content-type','text/event-stream');self.send_header('content-length',str(len(b)));self.end_headers();self.wfile.write(b)
# Private SFU: same deployed SFU binary, loopback listeners and fresh test-only
# credentials. The actual production agent name is safe on this isolated SFU.
sfu_manifest=json.loads((D/'SFU_BINARY_SOURCE.json').read_text());sfu_bin=D/'livekit-server.isolated'
assert sha(sfu_bin)==sfu_manifest['sha256']
sfu_key='isolated-dns';sfu_secret=secrets.token_hex(32)
config={'port':17880,'bind_addresses':['127.0.0.1'],'rtc':{'tcp_port':17881,'udp_port':17882,'node_ip':'127.0.0.1','use_external_ip':False,'enable_loopback_candidate':True,'interfaces':{'includes':['lo']}},'keys':{sfu_key:sfu_secret},'logging':{'level':'warn'}}
config_path=D/'isolated-sfu.yaml';config_path.write_text(json.dumps(config));config_path.chmod(0o600)
with (D/'isolated-sfu.log').open('w') as log:sfu=subprocess.Popen([str(sfu_bin),'--config',str(config_path)],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
(D/'isolated-sfu-process.json').write_text(json.dumps({'pid':sfu.pid,'sha256':sha(sfu_bin)}))
for _ in range(100):
    assert sfu.poll() is None,'isolated SFU failed'
    try:
        with socket.create_connection(('127.0.0.1',17880),timeout=.2):break
    except OSError:time.sleep(.1)
else:raise RuntimeError('isolated SFU startup timeout')
provider.update(LIVEKIT_URL='ws://127.0.0.1:17880',LIVEKIT_API_KEY=sfu_key,LIVEKIT_API_SECRET=sfu_secret)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
counter={'tts_dropped':0,'forwarded':0,'forward_errors':0};count_lock=threading.Lock()
def query_name(data):
    labels=[];i=12
    while i<len(data):
        n=data[i];i+=1
        if n==0:return b'.'.join(labels).decode('ascii').lower()
        if n>63 or i+n>len(data):raise ValueError('invalid query')
        labels.append(data[i:i+n]);i+=n
    raise ValueError('truncated query')
class DNSHandler(socketserver.BaseRequestHandler):
    def handle(self):
        data,sock=self.request
        try:
            name=query_name(data)
            if name=='cbm01.cn-huabei-1.xf-yun.com':
                with count_lock:counter['tts_dropped']+=1
                return
            with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as upstream:
                upstream.settimeout(2);upstream.sendto(data,('127.0.0.53',53));response,_=upstream.recvfrom(65535);sock.sendto(response,self.client_address)
            with count_lock:counter['forwarded']+=1
        except Exception:
            with count_lock:counter['forward_errors']+=1
class DNSServer(socketserver.ThreadingUDPServer):daemon_threads=True
dns=DNSServer(('127.86.0.53',53),DNSHandler);threading.Thread(target=dns.serve_forever,daemon=True).start()
result={'candidate':manifest['source_commit'],'formal_sha256':SHA,'production_before':before,'cases':[],'boundary':'isolated same-version SFU on loopback + mount namespace; synthetic LLM/SN; actual ASR/TTS; no production dispatch/DNS changes'}
cases=[('dns-new-normal','0',candidate,SHA,False,True),('dns-old-silent','0',Path('/proc')/pid/'exe',OLD,True,False),('dns-new-silent','0',candidate,SHA,True,True),('dns-new-ordered-silent','1',candidate,SHA,True,True)]
try:
    for label,kind,binary,expected,fault,want_pass in cases:
        folder=D/label;folder.mkdir(mode=0o700);(folder/'stub.conf').write_text('nameserver 127.86.0.53\noptions edns0 trust-ad\nsearch .\n')
        env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/root',**provider,'AGENT_NAME':'rust-worker','WORKER_MAX_JOBS':'1','RUST_LOG':'info','AGENT_GREETING_ENABLED':'0','FILLER_ENABLED':'0','VAD_MODEL_PATH':'/opt/p003-listening-p0-v380-session39/silero_vad.onnx','EOT_SOCK':str(folder/'no-eot.sock'),'P003_SEARCH_ENABLED':'0','P003_TTS_CONNECT_RECOVERY_V1':'1','P003_ASR_CONNECT_RECOVERY_V1':'1','P003_ASYNC_DNS_V1':'1','P003_TTS_DNS_HEDGE_V1':'1','P003_BUSINESS_WATCHDOG_MODE':'enforce','P003_BUSINESS_WATCHDOG_DEVICE_ALLOWLIST':SN,'LLM_BASE_URL':'http://127.0.0.1:'+str(server.server_port)+'/v1','LLM_API_KEY':'synthetic-isolated-only','LLM_MODEL':'synthetic-sky','P003_HOST_MOUNT_NS':before['host_mnt_namespace']}
        args=['unshare','--mount','--propagation','private','python3',str(D/'isolated-worker-launch.py'),str(folder),str(binary)] if fault else [str(binary)]
        counts_before=dict(counter)
        (D/'CURRENT_CASE.json').write_text(json.dumps({'label':label,'started_at':time.time()}))
        with (folder/'worker.log').open('w') as log:worker=subprocess.Popen(args,cwd=folder,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            for _ in range(200):
                assert worker.poll() is None,'isolated worker exited before registration'
                if 'registered worker' in (folder/'worker.log').read_text():break
                time.sleep(.1)
            else:raise RuntimeError('isolated registration timeout')
            assert sha(Path('/proc',str(worker.pid),'exe'))==expected
            worker_ns=os.readlink('/proc/'+str(worker.pid)+'/ns/mnt');assert (worker_ns!=before['host_mnt_namespace'])==fault
            assert production()==before,'production changed before probe'
            with (folder/'probe.log').open('w') as log:r=subprocess.run(['/root/voice-venv/bin/python',str(D/'formal-dns-probe.py'),kind],env={'PATH':'/usr/bin:/bin','HOME':'/root','P003_TEST_WORKER_PID':str(worker.pid),'P003_TEST_SHA':expected,'P003_TEST_LABEL':label},stdout=log,stderr=subprocess.STDOUT,timeout=110)
            body=json.loads((D/(label+'.json')).read_text());raw=re.sub(r'\x1b\[[0-9;]*m','',(folder/'worker.log').read_text())
            case={'label':label,'fault':fault,'rc':r.returncode,'want_pass':want_pass,'folder':str(folder),'result':body,'worker_namespace':worker_ns,'dns_packet_delta':{k:counter[k]-counts_before[k]for k in counter},'fallback_started':raw.count('tts slow DNS: bounded configured-upstream lookup started'),'fallback_path_observed':any('tts connection timing' in x and 'outcome="connected"' in x and 'dns_path="configured_upstream"' in x for x in raw.splitlines()),'timing_lines':[x for x in raw.splitlines() if any(s in x for s in ['tts connection timing','voice dns family timing','tts stream timing','playout metrics'])]}
            case['passed']=(r.returncode==0 and body['status']=='FUNCTIONAL_PASS' and (not fault or case['fallback_path_observed'])) if want_pass else (r.returncode!=0 and body['status']=='FAIL' and body['stats']['audible_ms']==0 and case['dns_packet_delta']['tts_dropped']>0 and 'tts' in raw and 'timeout' in raw)
            result['cases'].append(case);(D/'FORMAL_DNS_PROGRESS.json').write_text(json.dumps(result,indent=2))
            assert case['passed'],'case failed acceptance: '+label
        finally:
            worker.terminate()
            try:worker.wait(timeout=8)
            except subprocess.TimeoutExpired:worker.kill();worker.wait(timeout=3)
except BaseException as e:result['error']=type(e).__name__+': '+str(e)[:200]
finally:
    dns.shutdown();dns.server_close();server.shutdown();server.server_close();sfu.terminate();sfu.wait(timeout=10);result['isolated_sfu_exited']=sfu.returncode is not None;result['production_after']=production();result['production_unchanged']=result['production_after']==before;result['passed']=len(result['cases'])==len(cases) and all(c['passed']for c in result['cases']) and result['production_unchanged'];(D/'FORMAL_DNS_RESULT.json').write_text(json.dumps(result,indent=2));print(json.dumps({'passed':result['passed'],'cases':[{k:c[k]for k in ['label','passed','fallback_started','fallback_path_observed','dns_packet_delta']}for c in result['cases']],'error':result.get('error')}))

raise SystemExit(0 if result['passed'] else 1)
