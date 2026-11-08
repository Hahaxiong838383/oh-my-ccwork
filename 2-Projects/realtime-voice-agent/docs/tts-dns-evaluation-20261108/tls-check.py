"""Unauthenticated TCP/TLS validation of fresh DNS answers; preserves original SNI."""
import concurrent.futures,datetime,hashlib,ipaddress,json,re,socket,ssl,subprocess,time
HOST='cbm01.cn-huabei-1.xf-yun.com';servers=['127.0.0.53','1.1.1.1','8.8.8.8','223.5.5.5'];queries=[];owners={}
for server in servers:
 p=subprocess.run(['dig','@'+server,HOST,'A','+short','+time=1','+tries=1'],capture_output=True,text=True,timeout=3)
 ips=[]
 for line in p.stdout.splitlines():
  try:a=ipaddress.ip_address(line.strip())
  except ValueError:continue
  if a.version==4 and a.is_global:ips.append(str(a))
 queries.append({'server':server,'rc':p.returncode,'ips':ips,'output_sha256':hashlib.sha256(p.stdout.encode()).hexdigest()})
 for ip in ips[:2]:owners.setdefault(ip,[]).append(server)
def check(item):
 ip,via=item;start=time.monotonic();stage='tcp';raw=None;wrapped=None;tcp_ms=None
 try:
  raw=socket.create_connection((ip,443),timeout=3);tcp_ms=round((time.monotonic()-start)*1000,3);stage='tls';t=time.monotonic();wrapped=ssl.create_default_context().wrap_socket(raw,server_hostname=HOST)
  return {'ip':ip,'resolvers':via,'status':'verified','tcp_ms':tcp_ms,'tls_ms':round((time.monotonic()-t)*1000,3),'tls_version':wrapped.version(),'certificate_sha256':hashlib.sha256(wrapped.getpeercert(binary_form=True)).hexdigest()}
 except Exception as e:
  return {'ip':ip,'resolvers':via,'status':'failed','stage':stage,'tcp_ms':tcp_ms,'elapsed_ms':round((time.monotonic()-start)*1000,3),'error_type':type(e).__name__}
 finally:
  if wrapped:wrapped.close()
  elif raw:raw.close()
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:results=list(pool.map(check,owners.items()))
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':HOST,'queries':queries,'tls':results,'scope':'DNS+TCP+TLS only, no WebSocket authentication, no text or PCM, no changes to production resolution; TLS verifies original hostname, never certificate bypass'}))
