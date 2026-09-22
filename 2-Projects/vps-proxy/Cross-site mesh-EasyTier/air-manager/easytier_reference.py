"""Live reference from ET_NODES + peers/routes, bounded read-only service probes."""
import concurrent.futures
import http.client
import ipaddress
import json
import re
import shlex
import ssl
import time
from pathlib import Path

CATALOG=Path.home()/'mycc/2-Projects/vps-proxy/Cross-site mesh-EasyTier/scripts/common.sh'
CLI='/usr/local/bin/easytier-cli'
ROLES={'hk-relay':'香港 · 发现/兜底','mini':'公司 · Mini · 子网网关','studio':'公司 · Studio','dev198':'公司 · Linux · 子网网关','linux-lan':'家 · Linux · 子网网关','home-studio':'家 · 主力开发机','fnos2':'家 · 飞牛 NAS 2 · 子网网关','maxtkf-server':'家 · Windows','air':'Air · 本机'}
SERVICES=[
 {'id':'prnas_http','name':'公司 PRNAS','kind':'HTTP 管理页','scheme':'http','host':'10.10.61.18','port':5000,'lan':'192.168.61.18:5000','note':'正确管理口为5000；不是8080'},
 {'id':'prnas_https','name':'公司 PRNAS','kind':'HTTPS 管理页','scheme':'https','host':'10.10.61.18','port':5001,'lan':'192.168.61.18:5001','note':'保留证书校验；不自动忽略自签/名称不匹配'},
 {'id':'company_router','name':'公司网关','kind':'HTTP 后台','scheme':'http','host':'10.10.61.254','port':80,'lan':'192.168.61.254:80','note':'通过公司子网代理访问'},
 {'id':'home_router','name':'家庭路由器','kind':'HTTP 后台','scheme':'http','host':'10.10.1.1','port':80,'lan':'192.168.1.1:80','note':'通过家庭子网代理访问'}]


def mesh_ip(value):
 try:
  ip=ipaddress.ip_interface(str(value)).ip
  return str(ip) if ip in ipaddress.ip_network('10.10.10.0/24') else None
 except ValueError:return None


def parse_catalog(text):
 match=re.search(r'ET_NODES=\((.*?)\n\)',text,re.S)
 if not match:raise ValueError('catalog missing')
 result=[]
 for line in re.findall(r'^\s*"([^"\n]+)"',match.group(1),re.M):
  fields=line.split('|')
  if len(fields)!=5:continue
  name,alias,ip,platform=fields[:4]
  if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',name) or not mesh_ip(ip):continue
  # Deliberately never retain the fifth credential field.
  result.append({'name':name,'registered_ip':ip,'source_alias':alias,'platform':platform,'role':ROLES.get(name,'登记节点')})
 if not result:raise ValueError('catalog empty')
 return result


def route_map(raw):
 entries=json.loads(raw)
 if not isinstance(entries,list):raise ValueError('route shape')
 result={}
 for row in entries[:128]:
  if not isinstance(row,dict):continue
  ip=mesh_ip(row.get('ipv4',''))
  if ip:
   cidrs=[]
   for part in re.split(r'[,\s]+',str(row.get('proxy_cidrs',''))):
    try:cidrs.append(str(ipaddress.ip_network(part,strict=False)))
    except ValueError:pass
   result[ip]=cidrs
 return result


def probe_service(service,timeout=3):
 start=time.monotonic();conn=None
 out={'ok':False,'transport_ok':False,'code':'network_error','http_status':None,'ms':None}
 try:
  if service['scheme']=='https':
   conn=http.client.HTTPSConnection(service['host'],service['port'],timeout=timeout,context=ssl.create_default_context())
  else:conn=http.client.HTTPConnection(service['host'],service['port'],timeout=timeout)
  conn.request('GET','/',headers={'Connection':'close','User-Agent':'EasyTier-Reference-Health/1'})
  r=conn.getresponse();out.update(transport_ok=True,http_status=r.status,ok=200<=r.status<400 or r.status in (401,403),code='http_response')
 except ssl.SSLCertVerificationError:out.update(code='certificate_error',transport_ok=True)
 except TimeoutError:out['code']='timeout'
 except OSError:out['code']='network_error'
 except http.client.HTTPException:out['code']='http_error'
 finally:
  if conn:conn.close()
 out['ms']=round((time.monotonic()-start)*1000)
 return out


class ReferenceCollector:
 def __init__(self,catalog=CATALOG,service_probe=probe_service):
  self.catalog=Path(catalog);self.service_probe=service_probe;self.cache_stamp=None;self.cached=[];self.cache_at=0

 def registry(self,runner):
  stamp=(self.catalog.stat().st_mtime_ns,self.catalog.stat().st_size)
  if stamp==self.cache_stamp and time.time()-self.cache_at<300:return self.cached
  records=parse_catalog(self.catalog.read_text())
  for record in records:
   name=record['name'];vip=record['registered_ip'];record['ssh_command']=None;record['ssh_note']=''
   if name=='air':continue
   alias=name+'-mesh'
   rc,text=runner(['/usr/bin/ssh','-G',alias],timeout=2)
   config=dict(l.split(None,1) for l in text.splitlines() if len(l.split(None,1))==2)
   if rc==0 and config.get('hostname')==vip:
    record['ssh_command']='ssh '+shlex.quote(alias)
   else:
    user=record['source_alias'].split('@',1)[0] if '@' in record['source_alias'] else None
    if name=='hk-relay':user='root';record['ssh_note']='本机旧主机密钥须核对；不要跳过校验'
    if user and re.fullmatch(r'[A-Za-z0-9_.-]+',user):record['ssh_command']='ssh '+shlex.quote(user+'@'+vip)
    else:record['ssh_note']='未找到匹配的本机SSH别名'
   record.pop('source_alias',None)
  self.cache_stamp=stamp;self.cache_at=time.time();self.cached=records
  return records

 def collect(self,runner,peers,critical,local,previous,ssh_probe):
  now=time.time();catalog_error=False
  try:records=self.registry(runner)
  except (OSError,ValueError):records=[];catalog_error=True
  prior={r['name']:r for r in previous.get('devices',[]) if isinstance(r,dict) and isinstance(r.get('name'),str)}
  by_name={p['hostname']:p for p in peers};by_ip={p['ipv4']:p for p in peers};rows=[];used=set()
  for record in records:
   p=by_name.get(record['name']) or by_ip.get(record['registered_ip'])
   row=dict(record,ip=p['ipv4'] if p else record['registered_ip'],observed=bool(p),local=bool(p and p.get('cost')=='Local'),discovered=False)
   row.update(path=p.get('cost','') if p else '',lat_ms=p.get('lat_ms','') if p else '',protocol=p.get('tunnel_proto','') if p else '',last_seen=now if p else prior.get(record['name'],{}).get('last_seen'))
   # A renamed/reassigned live VIP must not keep an SSH alias pointing at an old address.
   if row['ip']!=row['registered_ip']:row['ssh_command']=None;row['ssh_note']='组网IP已变化；请核对SSH别名'
   rows.append(row)
   if p:used.add(p['ipv4'])
  for p in peers:
   if p['ipv4'] in used:continue
   rows.append({'name':p['hostname'],'ip':p['ipv4'],'registered_ip':None,'role':'自动发现 · 待登记','platform':'','observed':True,'local':p.get('cost')=='Local','discovered':True,'path':p.get('cost',''),'lat_ms':p.get('lat_ms',''),'protocol':p.get('tunnel_proto',''),'last_seen':now,'ssh_command':None,'ssh_note':'发现的新节点；用户名未登记'})
  # Keep recently discovered nodes visible after they vanish, rather than silently dropping them.
  names={r['name'] for r in rows}
  for name,old in prior.items():
   if name not in names and old.get('discovered') and mesh_ip(old.get('ip')) and len(rows)<128:
    rows.append({'name':name,'ip':old['ip'],'registered_ip':None,'role':'历史发现 · 待登记','platform':'','observed':False,'local':False,'discovered':True,'path':'','lat_ms':'','protocol':'','last_seen':old.get('last_seen'),'ssh_command':None,'ssh_note':'本轮未观测'})
  rc,raw=runner([CLI,'-p','127.0.0.1:15888','-o','json','route'],timeout=4)
  try:routes=route_map(raw) if rc==0 else {}
  except (ValueError,TypeError):routes={}
  checks={p['ip']:p for p in critical}
  targets=[r['ip'] for r in rows if r['observed'] and not r['local'] and r['ip'] not in checks]
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
   for result in ex.map(ssh_probe,targets):checks[result['ip']]=result
  for row in rows:
   row['proxy_cidrs']=routes.get(row['ip'],[])
   row['probe']=checks.get(row['ip']) if row['observed'] and not row['local'] else None
   if row['local']:row['physical_ip']=local.get('physical_ip','')
  services=[]
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
   results=list(ex.map(self.service_probe,SERVICES))
  for svc,result in zip(SERVICES,results):
   services.append(dict(svc,url=svc['scheme']+'://'+svc['host']+(':'+str(svc['port']) if svc['port'] not in (80,443) else '')+'/',probe=result))
  rows.sort(key=lambda r:(not r['local'],int(ipaddress.ip_address(r['ip']))))
  return {'checked_at':now,'catalog_error':catalog_error,'catalog_source':'scripts/common.sh · ET_NODES（读取，不执行）','devices':rows,'services':services,
          'counts':{'registered':len(records),'observed':sum(r['observed'] for r in rows),'unobserved':sum(not r['observed'] for r in rows),'ssh_ok':sum(bool(r.get('probe',{}).get('ok')) for r in rows if r.get('probe'))}}
