import socket,threading,time,subprocess,os,json,tempfile,pathlib
assert os.readlink('/proc/self/ns/net')!=os.readlink('/proc/1/ns/net'),'must run in isolated network namespace'
assert os.readlink('/proc/self/ns/mnt')!=os.readlink('/proc/1/ns/mnt'),'must run in isolated mount namespace'
subprocess.run(['mount','--make-rprivate','/'],check=True)
subprocess.run(['ip','link','set','lo','up'],check=True)
with tempfile.TemporaryDirectory(prefix='p003-r15-dns-') as td:
 f=pathlib.Path(td)/'resolv.conf';f.write_text('nameserver 127.0.0.1\noptions attempts:2\n')
 subprocess.run(['mount','--bind',str(f),str(pathlib.Path('/etc/resolv.conf').resolve())],check=True)
 sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);sock.bind(('127.0.0.1',53));sock.settimeout(.2)
 state={'mode':'recover','seen':{},'packets':0};stop=threading.Event()
 def serve():
  while not stop.is_set():
   try:p,a=sock.recvfrom(4096)
   except socket.timeout:continue
   pos=12
   while p[pos]:pos+=1+p[pos]
   end=pos+5;qtype=int.from_bytes(p[pos+1:pos+3],'big');key=qtype
   state['seen'][key]=state['seen'].get(key,0)+1;state['packets']+=1
   if state['mode']=='fail' or state['seen'][key]==1:continue
   answer=b'\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x1e\x00\x04\x7f\x00\x00\x01' if qtype==1 else b''
   hdr=p[:2]+b'\x81\x80\x00\x01'+(b'\x00\x01'if answer else b'\x00\x00')+b'\x00\x00\x00\x00'
   sock.sendto(hdr+p[12:end]+answer,a)
 th=threading.Thread(target=serve);th.start();results=[]
 try:
  for mode in ['recover','fail']:
   for opt in ['', 'timeout:1 attempts:2']:
    state.update(mode=mode,seen={},packets=0)
    env=dict(os.environ);env.pop('RES_OPTIONS',None)
    if opt:env['RES_OPTIONS']=opt
    t=time.monotonic();r=subprocess.run(['python3','-c',"import socket;socket.getaddrinfo('p003-r15-dns.test',443,type=socket.SOCK_STREAM)"],env=env,capture_output=True,text=True,timeout=15)
    results.append({'mode':mode,'res_options':opt or 'default','elapsed_ms':round((time.monotonic()-t)*1000,1),'success':r.returncode==0,'dns_packets':state['packets']})
 finally:stop.set();th.join();sock.close()
 print(json.dumps({'isolated_network_namespace':True,'isolated_mount_namespace':True,'results':results}))
 assert results[0]['success']and results[1]['success']
 assert results[0]['elapsed_ms']>=4800 and results[1]['elapsed_ms']<2500
 assert not results[2]['success']and not results[3]['success'] and results[3]['elapsed_ms']<3500
