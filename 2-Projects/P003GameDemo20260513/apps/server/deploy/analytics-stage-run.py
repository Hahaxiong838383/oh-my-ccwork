#!/usr/bin/env python3
"""Launch/stop isolated test services with fake keys and isolated cwd/data only."""
import argparse,json,os,signal,socket,subprocess,time,urllib.request
from pathlib import Path
from secrets import token_hex
ROOT=Path(os.environ.get('ANALYTICS_STAGE_ROOT','/opt/p003/analytics-staging-20261013'))
assert str(ROOT) in ['/opt/p003/analytics-staging-20261013','/opt/p003/analytics-control-staging-20261031']
ACTORS=int(os.environ.get('ANALYTICS_TEST_DEVICES','14')); assert ACTORS in [14,20]
NODE=Path(os.environ.get('ANALYTICS_NODE_PATH','/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node'))
if not NODE.is_absolute():raise RuntimeError('absolute analytics runtime required')
def run(args,cwd=None):
 p=subprocess.run(args,cwd=cwd,capture_output=True,text=True,check=True); return p.stdout

def alive(port,timeout=2):
 try:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=timeout) as r:return r.status==200
 except Exception:return False

def occupied(port):
 with socket.socket() as sock:return sock.connect_ex(('127.0.0.1',port))==0

def stop_one(name):
 p=ROOT/(name+'.pid')
 if not p.exists():return
 pid=int(p.read_text())
 if not (Path('/proc')/str(pid)).exists():p.unlink();return
 try:
  cwd=Path('/proc')/str(pid)/'cwd'
  if cwd.resolve()!=ROOT/'server':raise RuntimeError('staging pid cwd mismatch')
  os.killpg(pid,signal.SIGTERM)
 except ProcessLookupError:pass
 port=3005 if name=='gateway' else 3306
 for _ in range(50):
  if not (Path('/proc')/str(pid)).exists() and not occupied(port):break
  time.sleep(.1)
 else:raise RuntimeError('staging shutdown timeout; pid record retained')
 p.unlink(missing_ok=True)

def start_one(name,script):
 if alive(3005 if name=='gateway' else 3306):raise RuntimeError('staging port already used')
 f=(ROOT/(name+'.log')).open('ab'); os.chmod(f.name,0o600)
 env=os.environ.copy(); env['NODE_OPTIONS']='--experimental-sqlite --max-old-space-size=256'; env['NO_PROXY']='*'; env['HTTP_PROXY']='';env['HTTPS_PROXY']='';env['ALL_PROXY']=''
 env['ANALYTICS_NODE_PATH']=str(NODE)
 p=subprocess.Popen([str(NODE),'./node_modules/tsx/dist/cli.mjs','--env-file=.env.stage',script],cwd=ROOT/'server',env=env,stdout=f,stderr=f,start_new_session=True); f.close()
 (ROOT/(name+'.pid')).write_text(str(p.pid)); os.chmod(ROOT/(name+'.pid'),0o600)
 deadline=time.monotonic()+60
 while time.monotonic()<deadline:
  if alive(3005 if name=='gateway' else 3306,timeout=min(2,max(.001,deadline-time.monotonic()))):return
  if p.poll() is not None:raise RuntimeError('staging child failed, inspect protected stage log')
  time.sleep(min(.2,max(0,deadline-time.monotonic())))
 raise RuntimeError('staging startup wait exceeded 60s; child/pid retained, inspect health before restart')

def main():
 p=argparse.ArgumentParser();p.add_argument('action',choices=['start','restart-ingest','stop']);a=p.parse_args()
 if a.action=='stop':
  stop_one('ingest');stop_one('gateway')
  c=ROOT/'nginx.conf'
  if (ROOT/'nginx.pid').exists():run(['/usr/sbin/nginx','-p',str(ROOT)+'/', '-c',str(c),'-s','quit'])
  print(json.dumps({'ok':True,'staging_stopped':True}));return
 if a.action=='restart-ingest':stop_one('ingest');start_one('ingest','deploy/analytics-stage-ingest.ts');print(json.dumps({'ok':True,'ingest_restarted':True}));return
 if any(occupied(port) for port in [3005,3306,13306]):raise RuntimeError('staging already running; credentials were not changed')
 server=ROOT/'server'; (server/'data').mkdir(parents=True,exist_ok=True,mode=0o700)
 subjects=['BJP003261013'+str(i+1).zfill(8) for i in range(ACTORS)]
 values={'ANALYTICS_STAGE_ROOT':str(ROOT),'ANALYTICS_TEST_DEVICES':str(ACTORS),'AUTH_JWT_SECRET':token_hex(32),'ANALYTICS_DEVICE_KEY_SECRET':token_hex(32),'ANALYTICS_INTERNAL_SECRET':token_hex(32),'ANALYTICS_DB_PATH':str(server/'data/analytics.db'),'ANALYTICS_DEVICES_DB_PATH':str(server/'data/devices.db'),'ANALYTICS_CONFIG_DB_PATH':str(server/'data/config.db'),'ANALYTICS_CONTROL_PATH':str(server/'data/analytics-control.json'),'ANALYTICS_SN_ALLOW':','.join(subjects),'ANALYTICS_GLOBAL_RPM':'600','ANALYTICS_INTERNAL_URL':'http://127.0.0.1:3306','STUDIO_USER':'analytics-stage-admin','STUDIO_PASS':token_hex(16),'STUDIO_EDITOR_USERS':'analytics-stage-editor','STUDIO_EDITOR_PASS':token_hex(16),'STUDIO_GUEST_USER':'analytics-stage-guest','STUDIO_GUEST_PASS':token_hex(16),'CONFIG_DB_PATH':str(server/'data/config.db'),'DEVICES_DB_PATH':str(server/'data/devices.db'),'PORT':'3005'}
 env=server/'.env.stage';fresh=not env.exists()
 if fresh:
  env.write_text(''.join(k+'='+v+'\n' for k,v in values.items()));os.chmod(env,0o600)
  run(['/usr/bin/python3','scripts/analytics-control.py','--control',values['ANALYTICS_CONTROL_PATH'],'--enable'],cwd=server)
 start_one('gateway','deploy/analytics-stage-gateway.ts')
 if fresh:run([str(NODE),'./node_modules/tsx/dist/cli.mjs','--env-file=.env.stage','deploy/analytics-stage-seed.ts'],cwd=server)
 start_one('ingest','deploy/analytics-stage-ingest.ts')
 snippet=(server/'deploy/nginx/analytics-location.conf').read_text().replace('127.0.0.1:3006','127.0.0.1:3306')
 (ROOT/'nginx-location.conf').write_text(snippet)
 c=ROOT/'nginx.conf';c.write_text('pid '+str(ROOT/'nginx.pid')+';\nerror_log '+str(ROOT/'nginx-error.log')+';\nevents { worker_connections 1024; }\nhttp { access_log off; server { listen 127.0.0.1:13306; include '+str(ROOT/'nginx-location.conf')+'; } }\n')
 run(['/usr/sbin/nginx','-p',str(ROOT)+'/', '-c',str(c),'-t']);run(['/usr/sbin/nginx','-p',str(ROOT)+'/', '-c',str(c)])
 print(json.dumps({'ok':True,'stage_root':str(ROOT),'gateway_port':3005,'ingest_port':3306,'proxy_port':13306,'real_device_data_used':False}))
if __name__=='__main__':main()
