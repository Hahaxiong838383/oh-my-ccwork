import pathlib,subprocess,tempfile,shutil,os,time,signal,hashlib
S=pathlib.Path(__file__).parent
checks=0
def check(ok,msg):
 global checks
 assert ok,msg
 checks+=1
 print('PASS',msg,flush=True)
def run(args,**kw):return subprocess.run(args,text=True,capture_output=True,**kw)
with tempfile.TemporaryDirectory(prefix='yt-integration-fixture-') as td:
 p=pathlib.Path(td);d=p/'video-proxy';r=d/'youtube-failover';b=p/'bin';r.mkdir(parents=True);b.mkdir()
 c=p/'fake.c';c.write_text('#include <unistd.h>\nint main(int argc,char**argv){sleep(60);return 0;}\n')
 subprocess.run(['cc',str(c),'-o',str(d/'sing-box')],check=True)
 s=(S/'video-boot-start.next.sh').read_text();a=s.index('production_proxy_running() {');z=s.index('\n}\n',a)+3;func=s[a:z]
 def detect():return run(['sh','-c',func+'\nD="$1"\nproduction_proxy_running','sh',str(d)]).returncode==0
 check(not detect(),'no production process is absent')
 worker=subprocess.Popen([str(d/'sing-box'),'run','-c',str(r/'workers/rack/config.json')])
 try:
  check(not detect(),'worker same binary is not mistaken for main')
  main=subprocess.Popen([str(d/'sing-box'),'run','-c',str(d/'config.json')])
  try: check(detect(),'exact main executable/config recognized with worker present')
  finally:main.terminate();main.wait()
  check(not detect(),'worker remains yet main is absent after stop')
 finally:worker.terminate();worker.wait()
 check(s.index('log clock_verified')<s.index('owned_pid=$!')<s.index('service.sh" boot-start')<s.index('dns_not_ready'),'DNS guard starts after validated clock/main and before DNS ready gate')
 check(s.count('production_proxy_running')==4 and 'pidof sing-box' not in s,'main checks including config rollback use exact process identity')
 for name in ['service.sh','guard-run.sh']:shutil.copyfile(S/name,r/name)
 (r/'release-id').write_text('test-release\n');(r/'release-id').chmod(0o600);(r/'guard.dex').write_text('fixture');(r/'guard-config.json').write_text('{}')
 w=r/'workerctl.sh';w.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$(dirname "$0")/calls"\n');w.chmod(0o700)
 (d/'config.json').write_text('{}');(r/'active-main.sha256').write_text(hashlib.sha256(b'{}').hexdigest()+'\n')
 (b/'busybox').write_text('#!/bin/sh\nexec "$@"\n');(b/'busybox').chmod(0o700)
 shutil.copyfile(d/'sing-box',b/'app_process');(b/'app_process').chmod(0o700)
 env=dict(os.environ,VIDEO_PROXY_BUSYBOX=str(b/'busybox'),PATH=str(b)+':'+os.environ['PATH'])
 def service(action):return run(['sh',str(r/'service.sh'),action],env=env,timeout=20)
 q=service('boot-start');check(q.returncode==20,'inactive release refuses all service mutations')
 check(not (r/'calls').exists() and not (r/'authorized-boot-id').exists(),'inactive rejection leaves no worker calls or boot authorization')
 (r/'enabled').write_text('wrong-release\n');(r/'enabled').chmod(0o600);q=service('boot-start');check(q.returncode==20,'wrong release marker is rejected')
 (r/'enabled').write_text('test-release\n');(r/'active-main.sha256').write_text('bad\n');q=service('boot-start');check(q.returncode==21,'wrong production config rejected before authorization')
 check(not (r/'calls').exists() and not (r/'authorized-boot-id').exists(),'wrong config creates zero runtime side effects')
 (r/'active-main.sha256').write_text(hashlib.sha256(b'{}').hexdigest()+'\n')
 q=service('boot-start');check(q.returncode==0,'authorized matching release starts fixture guardian')
 pid=int((r/'guard.pid').read_text())
 try:
  check((r/'authorized-boot-id').read_text().strip()==pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'boot authorization derives actual current boot')
  q=service('boot-start');check(q.returncode==0 and int((r/'guard.pid').read_text())==pid,'repeated start keeps exactly same guardian')
  check(service('status').returncode==0,'status works on live fixture')
 finally:
  (r/'enabled').unlink()
  os.kill(pid,signal.SIGTERM)
  time.sleep(.2)
 print('TOTAL',checks,flush=True)
