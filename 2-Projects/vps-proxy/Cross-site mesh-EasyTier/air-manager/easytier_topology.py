"""Credential-free, fixed-endpoint topology observations. No arbitrary network targets."""
import ipaddress
import json
import time
from pathlib import Path

CLI='/usr/local/bin/easytier-cli'
CONFIG=Path(__file__).with_name('easytier-topology.json')
ENDPOINTS=[
 ('home4','家庭 IPv4','tcp://mesh4.hahaxiong.cc:21110','mesh4.hahaxiong.cc','A'),
 ('home6','家庭 IPv6','tcp://mesh6.hahaxiong.cc:21110','mesh6.hahaxiong.cc','AAAA'),
 ('hk4','香港 IPv4','tcp://85.189.55.23:443',None,None),
 ('hk6','香港 IPv6','tcp://[2001:df1:7880:6::1ca]:443',None,None),
 ('lan_nas','家内 NAS 直连','tcp://192.168.1.115:11010',None,None),
 ('lan_pc','家内开发机直连','tcp://192.168.1.133:11010',None,None)]


def parse_connectors(raw):
    entries=json.loads(raw)
    if not isinstance(entries,list):raise ValueError('not connector list')
    allow={x[2] for x in ENDPOINTS}
    result={}
    for item in entries[:128]:
        if not isinstance(item,dict):continue
        value=item.get('url')
        url=value.get('url') if isinstance(value,dict) else value
        if url in allow:
            result[url]={0:'connected',1:'connecting',2:'disconnected'}.get(item.get('status'),'unknown')
    return result


def read_deployment():
    try:
        value=json.loads(CONFIG.read_text())
        # Explicit projection: config additions never become a secret-export interface.
        return {k:value[k] for k in ['schema','deployed_at','verified_at','nas_lan','nas_mesh','lucky_port','easytier_port','ddns_interval_seconds','router_model','router_gateway','lease_keeper','verification','fn2_aaaa_repaired'] if k in value}
    except (OSError,ValueError,TypeError):return {}


def collect(runner):
    code,raw=runner([CLI,'-p','127.0.0.1:15888','-o','json','connector'],timeout=4)
    try:states=parse_connectors(raw) if code==0 else {}
    except (ValueError,TypeError):states={}
    rows=[]
    for ident,name,url,host,kind in ENDPOINTS:
        row={'id':ident,'name':name,'url':url,'state':states.get(url,'not_observed'),'resolved':[],'dns_status':'not_applicable'}
        if host:
            rc,answer=runner(['/usr/bin/dig','+time=1','+tries=1','+short',host,kind],timeout=3)
            if rc==0:
                for line in answer.splitlines():
                    try:
                        address=ipaddress.ip_address(line.strip())
                        if address.version==(4 if kind=='A' else 6):row['resolved'].append(str(address))
                    except ValueError:pass
            row['resolved']=list(dict.fromkeys(row['resolved']))[:8]
            row['dns_status']='resolved' if row['resolved'] else 'unresolved'
        rows.append(row)
    return {'observed_at':time.time(),'endpoints':rows,'deployment':read_deployment(),
            'note':'拓扑表示已配置的发现/兜底入口；不是当前每条业务流量的实际路径。P2P 优先，实际路径见下方节点表。'}
