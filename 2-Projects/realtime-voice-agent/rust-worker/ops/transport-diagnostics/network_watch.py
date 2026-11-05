#!/usr/bin/env python3
"""Bounded passive metadata recorder for an intermittent provider transport fault.
No audio, TLS payload, signed URL, credentials or user transcript is persisted.
Requires Linux CAP_NET_RAW. Does not change network/service configuration.
"""
import argparse,collections,hashlib,json,pathlib,re,socket,struct,subprocess,threading,time,signal
HOST='cbm01.cn-huabei-1.xf-yun.com'
NAMES={HOST,'hb-kaicp.xf-gtm.com'}

def skip_name(b,p):
    while p<len(b):
        n=b[p];p+=1
        if n==0:return p
        if n&192==192:return p+1
        if n>63:raise ValueError('label')
        p+=n
    raise ValueError('truncated')

def parse_packet(b,iface,kind,at,peers):
    if iface not in {'ens17','lo'} or len(b)<34 or b[12:14]!=b'\x08\x00':return None
    h=14+(b[14]&15)*4
    if h<34 or len(b)<h+8:return None
    src=socket.inet_ntoa(b[26:30]);dst=socket.inet_ntoa(b[30:34])
    base={'at':at,'iface':iface,'direction':'out'if kind==4 else'in','src':src,'dst':dst}
    if b[23]==6:
        if len(b)<h+20 or not ({src,dst}&peers):return None
        sp,dp,seq,ack=struct.unpack('!HHII',b[h:h+12])
        if 443 not in [sp,dp]:return None
        total=struct.unpack('!H',b[16:18])[0];n=max(0,total-(h-14)-(b[h+12]>>4)*4)
        return dict(base,proto='tcp',sp=sp,dp=dp,seq=seq,ack=ack,flags=b[h+13],data_len=n,window=struct.unpack('!H',b[h+14:h+16])[0])
    if b[23]!=17:return None
    sp,dp=struct.unpack('!HH',b[h:h+4])
    if 53 not in [sp,dp]:return None
    d=b[h+8:]
    if len(d)<17:return None
    ident,flags,qd,an=struct.unpack('!HHHH',d[:8])
    if qd!=1:return None
    p=12;labels=[]
    try:
        while d[p]:
            n=d[p];p+=1
            if n>63:raise ValueError('label')
            labels.append(d[p:p+n].decode('ascii'));p+=n
        p+=1;name='.'.join(labels).lower();qt=struct.unpack('!H',d[p:p+2])[0];p+=4
        if name not in NAMES:return None
        ips=[]
        for _ in range(min(an,32)):
            p=skip_name(d,p);typ,cls,ttl,n=struct.unpack('!HHIH',d[p:p+10]);p+=10
            if typ==1 and cls==1 and n==4 and len(d)>=p+4:ips.append(socket.inet_ntoa(d[p:p+4]))
            p+=n
        return dict(base,proto='dns',sp=sp,dp=dp,id=ident,qr=bool(flags&0x8000),rcode=flags&15,tc=bool(flags&0x200),qname=name,qtype=qt,ips=ips)
    except (ValueError,IndexError,struct.error,UnicodeError):return None

MARKERS=('tts connection timing','tts stream timing','playout metrics')
SAFE_KEYS={'connect_id','stage','outcome','dns_ms','tcp_ms','tls_ws_ms','dns_path','local','peer','turn_id','phase','completed','pcm_frames','elapsed_ms','ws_read_wait_ms','max_ws_read_wait_ms','channel_send_wait_ms','max_channel_send_wait_ms','max_observed_pcm_gap_ms','pending_wait_ms','underrun_count','underrun_ms','played_frames','exit'}
def log_event(raw):
    x=json.loads(raw);m=x.get('MESSAGE','')
    if isinstance(m,list):m=bytes(m).decode('utf8','replace')
    m=re.sub(r'\x1b\[[0-9;]*m','',m);marker=next((v for v in MARKERS if v in m),None)
    if not marker:return None
    fields={k:v.strip('"')for k,v in re.findall(r'\b([a-z_]+)=("[^"]*"|[^\s]+)',m)if k in SAFE_KEYS}
    return {'at':int(x['__REALTIME_TIMESTAMP'])/1e6,'proto':'worker_timing','marker':marker,'fields':fields}

def incident(e):
    if e.get('proto')!='worker_timing':return False
    f=e['fields']
    if f.get('outcome')=='timeout':return True
    for k,limit in [('dns_ms',1000),('tcp_ms',900),('tls_ws_ms',1500),('underrun_ms',1000),('max_ws_read_wait_ms',1000)]:
        try:
            if int(f.get(k,'0'))>=limit:return True
        except ValueError:pass
    return False

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',required=True);ap.add_argument('--seconds',type=int,default=86400);args=ap.parse_args()
    if not 1<=args.seconds<=86400:raise SystemExit('duration outside bounds')
    out=pathlib.Path(args.output);out.mkdir(mode=0o700,parents=True,exist_ok=True)
    ring=collections.deque(maxlen=16000);lock=threading.Lock();stop=threading.Event();peers=set();counts=collections.Counter();pending=[];started=time.time()
    try:peers.update(x[4][0]for x in socket.getaddrinfo(HOST,443,0,socket.SOCK_STREAM)if x[0]==socket.AF_INET)
    except OSError:counts['initial_resolve_error']+=1
    def add(e):
        with lock:
            ring.append(e);counts[e['proto']]+=1
            if e['proto']=='tcp':counts['tcp_'+e['direction']]+=1
            if incident(e):
                counts['triggers']+=1
                if not pending or time.time()-pending[-1]['at']>30:pending.append({'at':time.time(),'event':e})
    def packets():
        # ETH_P_ALL is required for outgoing frames too. ETH_P_IP alone missed
        # client SYN/ACK in the initial short probes; do not reuse that omission.
        s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(0x0003));s.settimeout(.25)
        try:
            while not stop.is_set():
                try:b,a=s.recvfrom(2048)
                except socket.timeout:continue
                e=parse_packet(b,a[0],a[2],time.time(),peers)
                if e:
                    if e['proto']=='dns' and e['qr']:peers.update(e['ips'][:max(0,128-len(peers))])
                    add(e)
        finally:s.close()
    p=subprocess.Popen(['journalctl','-u','voice-worker-rust','--since','now','--follow','--no-pager','-o','json'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
    def logs():
        for raw in p.stdout:
            if stop.is_set():break
            try:e=log_event(raw)
            except (ValueError,KeyError,TypeError):continue
            if e:add(e)
    signal.signal(signal.SIGTERM,lambda *_:stop.set())
    threads=[threading.Thread(target=packets,daemon=True),threading.Thread(target=logs,daemon=True)]
    for t in threads:t.start()
    def write(path,data):
        tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False));tmp.chmod(0o600);tmp.replace(path)
    try:
        while not stop.is_set() and time.time()-started<args.seconds:
            time.sleep(1)
            with lock:
                now=time.time()
                while pending and now-pending[0]['at']>=15:
                    hit=pending.pop(0);window=[v for v in ring if hit['at']-20<=v['at']<=hit['at']+15][-8000:]
                    write(out/f"incident-{int(hit['at']*1000)}.json",{'trigger':hit,'events':window,'metadata_only':True})
                    for old in sorted(out.glob('incident-*.json'))[:-6]:old.unlink()
                status={'started':started,'expires':started+args.seconds,'at':now,'counts':dict(counts),'ring_items':len(ring),'pending':len(pending),'threads_alive':[t.is_alive()for t in threads],'metadata_only':True,'incident_limit':6,'record_limit_per_incident':8000}
            write(out/'status.json',status)
    finally:
        stop.set();p.terminate()
        try:p.wait(timeout=3)
        except subprocess.TimeoutExpired:p.kill();p.wait()
        for t in threads:t.join(timeout=1)
        with lock:write(out/'tail.json',{'events':list(ring)[-8000:],'metadata_only':True,'ended':time.time()})
if __name__=='__main__':main()
