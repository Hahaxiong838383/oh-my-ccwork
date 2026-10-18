#!/usr/bin/env python3
"""Build an inactive YouTube failover release from a protected sing-box config.
No device access or activation. Secrets are never printed; all generated files 0600.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys

ROOT = '/data/adb/video-proxy/youtube-failover'
CANDIDATES = [('yt-rack-hy2',19101,'rack'),('yt-rack-reality',19102,None),('yt-zgo-reality',19103,None),('yt-zgo-hy2',19104,'zgo')]
SOURCE_TAGS = {'rack_hy2':'hy2','rack_reality':'reality','zgo_reality':'zgo-netflix','zgo_hy2':'zgo-hy2'}

class InvalidInput(Exception): pass

def fail(condition, message):
    if not condition: raise InvalidInput(message)

def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':')).encode()

def build(source, uid_map, root=ROOT, tags=None):
    tags = tags or SOURCE_TAGS
    fail(isinstance(uid_map,dict) and bool(uid_map), 'UID map must contain package names and integer UIDs')
    for package, uid in uid_map.items():
        fail(isinstance(package,str) and package and isinstance(uid,int) and not isinstance(uid,bool) and 10000<=uid<=2147483647, 'invalid package/UID entry')
    fail(root.startswith('/') and '\n' not in root and '|' not in root and not root.endswith('/'), 'runtime root must be an absolute normalized path')
    source=copy.deepcopy(source)
    outbounds=source.get('outbounds',[])
    by_tag={o.get('tag'):o for o in outbounds}
    fail(len(by_tag)==len(outbounds),'outbound tags are missing or duplicated')
    for key,tag in tags.items(): fail(tag in by_tag, 'required source outbound is absent: '+key)
    for key in ('rack_hy2','zgo_hy2'):
        fail(by_tag[tags[key]].get('type')=='hysteria2','HY2 source type mismatch: '+key)
        fail(not by_tag[tags[key]].get('detour'),'HY2 source uses an unsupported nested detour: '+key)
    for key in ('rack_reality','zgo_reality'):
        ob=by_tag[tags[key]]
        fail(ob.get('type')=='vless' and ob.get('tls',{}).get('reality',{}).get('enabled'), 'Reality source type mismatch: '+key)
    uids=sorted(set(uid_map.values()))
    tun=[i for i in source.get('inbounds',[]) if i.get('type')=='tun']
    fail(len(tun)==1 and all(uid in tun[0].get('include_uid',[]) for uid in uids), 'all supplied YouTube UIDs must already belong to the original TUN')
    reserved={c[0] for c in CANDIDATES}|{'youtube-video','dns-uplink','dns-rack-reality','dns-zgo-reality'}
    fail(not reserved.intersection(by_tag),'input already contains a failover release or reserved outbound tags')
    existing_ports={i.get('listen_port') for i in source.get('inbounds',[])}
    fail(not existing_ports.intersection({19101,19102,19103,19104,19111,19112,19201,19202}),'reserved failover port already exists in source')
    controller=source.get('experimental',{}).get('clash_api',{})
    fail(controller.get('external_controller')=='127.0.0.1:19090','API must remain loopback 127.0.0.1:19090')
    secret=controller.get('secret')
    fail(isinstance(secret,str) and bool(secret) and '\n' not in secret, 'API secret is absent or invalid')
    main=copy.deepcopy(source)
    extra=[]
    for name,key in [('yt-rack-reality','rack_reality'),('yt-zgo-reality','zgo_reality'),('dns-rack-reality','rack_reality'),('dns-zgo-reality','zgo_reality')]:
        ob=copy.deepcopy(by_tag[tags[key]]); ob['tag']=name; extra.append(ob)
    for name,port in [('yt-rack-hy2',19201),('yt-zgo-hy2',19202)]:
        extra.append({'type':'socks','tag':name,'server':'127.0.0.1','server_port':port,'version':'5'})
    extra += [{'type':'selector','tag':'youtube-video','outbounds':[c[0] for c in CANDIDATES],'default':'yt-rack-reality','interrupt_exist_connections':False},
              {'type':'selector','tag':'dns-uplink','outbounds':['dns-rack-reality','dns-zgo-reality'],'default':'dns-zgo-reality','interrupt_exist_connections':True}]
    main['outbounds'].extend(extra)
    probe_rules=[]
    probes=[(tag,port) for tag,port,_ in CANDIDATES]+[('dns-rack-reality',19111),('dns-zgo-reality',19112)]
    for tag,port in probes:
        inbound='probe-'+tag
        main['inbounds'].append({'type':'socks','tag':inbound,'listen':'127.0.0.1','listen_port':port})
        probe_rules.append({'inbound':[inbound],'action':'route','outbound':tag})
    rules=main.get('route',{}).get('rules')
    fail(isinstance(rules,list), 'source has no route rules')
    index=0
    # Production keeps the Netflix CDN match ahead of sniff because sniff may
    # lose the original domain. Preserve only that precisely bounded exception.
    while index<len(rules) and rules[index].get('action') not in ('sniff','hijack-dns'):
        r=rules[index]
        fail(set(r).issubset({'inbound','domain_suffix','outbound','action'}) and
             r.get('inbound')==[tun[0].get('tag')] and r.get('domain_suffix')==['nflxvideo.net'] and
             r.get('outbound')=='zgo-video' and r.get('action','route')=='route',
             'unsupported traffic-catching rule before sniff/DNS-hijack; manual review required')
        index+=1
    sniff_start=index
    while index<len(rules) and rules[index].get('action') in ('sniff','hijack-dns'): index+=1
    fail(index>sniff_start and any(r.get('action')=='hijack-dns' for r in rules[sniff_start:index]), 'source must have a contiguous sniff/DNS-hijack block')
    fail(not any(r.get('action') in ('sniff','hijack-dns') for r in rules[index:]), 'source has later sniff/DNS-hijack rules; manual review required')
    main['route']['rules']=rules[:index]+probe_rules+[{'user_id':uids,'action':'route','outbound':'youtube-video'}]+rules[index:]
    found=0
    dns_probe_ip=None
    dns_probe_name=None
    for server in main.get('dns',{}).get('servers',[]):
        if server.get('tag')=='zgo-dns':
            fail(server.get('type')=='tls' and server.get('server')=='1.1.1.1' and server.get('detour')==tags['zgo_reality'], 'zgo-dns expected original TLS source changed')
            dns_probe_ip=server['server']
            # Match the actual production DoT TLS identity; an omitted SNI/name
            # means certificate validation against the numeric server address.
            tls=server.get('tls') or {}
            fail(isinstance(tls,dict),'zgo-dns TLS options must be an object')
            dns_probe_name=tls.get('server_name') or dns_probe_ip
            fail(isinstance(dns_probe_name,str) and bool(dns_probe_name),'zgo-dns TLS server name is invalid')
            server['detour']='dns-uplink'; found+=1
    fail(found==1,'exactly one original zgo-dns is required')
    workers={}
    for name,key,port in [('rack','rack_hy2',19201),('zgo','zgo_hy2',19202)]:
        ob=copy.deepcopy(by_tag[tags[key]])
        ob.update({'tag':'worker-hy2','bind_interface':'eth0','routing_mark':255})
        # Isolated bootstrap never resolves through the HY2 service or main 5354.
        ob['domain_resolver']={'server':'worker-bootstrap','strategy':'ipv4_only'}
        workers[name]={'log':{'level':'warn','timestamp':True},
            'dns':{'servers':[{'type':'udp','tag':'worker-bootstrap','server':'223.5.5.5','server_port':53,'detour':'worker-direct'}],'final':'worker-bootstrap','strategy':'ipv4_only'},
            'inbounds':[{'type':'socks','tag':'worker-in','listen':'127.0.0.1','listen_port':port}],
            'outbounds':[ob,{'type':'direct','tag':'worker-direct','bind_interface':'eth0','routing_mark':255}],
            'route':{'final':'worker-hy2','default_mark':255,'default_interface':'eth0'}}
    guard={'secret_file':root+'/api-secret','state_file':root+'/guard-state.json','enabled_marker':root+'/enabled',
        'boot_guard_file':root+'/authorized-boot-id','release_id_file':root+'/release-id','boot_id_file':'/proc/sys/kernel/random/boot_id',
        'workerctl':root+'/workerctl.sh','dry_run':False,'api_port':19090,'selector':'youtube-video',
        'interval_ms':30000,'retry_ms':2000,'probe_timeout_ms':12000,'api_timeout_ms':12000,'foreground_timeout_ms':4000,
        'recovery_interval_ms':60000,'recovery_successes':3,'recovery_hold_ms':300000,
        'candidates':[dict({'tag':tag,'socks_port':port},**({'worker':worker} if worker else {})) for tag,port,worker in CANDIDATES],
        'dns':{'selector':'dns-uplink','candidates':[{'tag':'dns-rack-reality','socks_port':19111},{'tag':'dns-zgo-reality','socks_port':19112}],
               'server_ip':dns_probe_ip,'server_name':dns_probe_name,'query_host':'www.youtube.com'}}
    observe=copy.deepcopy(guard); observe['dry_run']=True; observe['state_file']=root+'/guard-observe-state.json'
    payload={'main':main,'workers':workers,'guard':guard,'observe':observe,'uid_map':uid_map}
    release=hashlib.sha256(canonical(payload)).hexdigest()
    return {'main-config.json':main,'workers/rack/config.json':workers['rack'],'workers/zgo/config.json':workers['zgo'],
            'guard-config.json':guard,'guard-observe.json':observe,'uid-map.json':uid_map},secret,release

def assemble(source, uid_map, root, scripts, release_id=None):
    """Pure in-memory package: relative paths -> exact bytes; caller controls I/O."""
    files,secret,derived=build(source,uid_map,root)
    if release_id is not None:
        fail(isinstance(release_id,str) and 1<=len(release_id)<=128 and all(c.isalnum() or c in '._-' for c in release_id), 'invalid release ID')
    result={name:(json.dumps(value,indent=2)+'\n').encode() for name,value in files.items()}
    for name in ['workerctl.sh','worker-safe-check.sh']:
        fail(name in scripts and isinstance(scripts[name],bytes), 'required script bytes absent')
        result[name]=scripts[name]
    release_id=release_id or hashlib.sha256(derived.encode()+b''.join(hashlib.sha256(result[n]).digest() for n in sorted(result))).hexdigest()
    result['api-secret']=(secret+'\n').encode()
    result['release-id']=(release_id+'\n').encode()
    for worker in ['rack','zgo']:
        name='workers/'+worker+'/config.json'
        result['workers/'+worker+'/config.sha256']=(hashlib.sha256(result[name]).hexdigest()+'\n').encode()
    manifest={'release_id':release_id,'activation':'inactive; no enabled or authorized-boot-id files created',
              'files':{name:hashlib.sha256(data).hexdigest() for name,data in sorted(result.items())}}
    result['manifest.json']=(json.dumps(manifest,indent=2)+'\n').encode()
    return result

def write_release(destination, contents):
    destination=Path(destination)
    fail(not destination.exists(),'output directory must not already exist')
    destination.mkdir(mode=0o700,parents=False)
    try:
        for name,data in contents.items():
            target=destination/name
            target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            mode=0o700 if name.endswith('.sh') else 0o600
            with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode),'wb') as stream: stream.write(data)
        for target in destination.rglob('*'):
            if target.is_dir(): os.chmod(target,0o700)
    except Exception:
        shutil.rmtree(destination)
        raise

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True);p.add_argument('--uid-map',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--runtime-root',default=ROOT)
    args=p.parse_args()
    try:
        fail(stat.S_IMODE(args.source.stat().st_mode)&0o077==0,'source config must not be accessible to group/others')
        scripts={name:(Path(__file__).resolve().parent/name).read_bytes() for name in ['workerctl.sh','worker-safe-check.sh']}
        contents=assemble(json.loads(args.source.read_text()),json.loads(args.uid_map.read_text()),args.runtime_root,scripts)
        write_release(args.output,contents)
    except (InvalidInput,OSError,ValueError,KeyError,TypeError):
        print('generation refused: input shape, permissions or output path invalid; no credentials displayed',file=sys.stderr)
        return 1
    print('inactive release generated; no services started and no activation markers created')
    return 0
if __name__=='__main__': sys.exit(main())
