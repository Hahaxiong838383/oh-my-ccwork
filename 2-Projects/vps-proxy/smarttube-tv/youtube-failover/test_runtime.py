#!/usr/bin/env python3
"""Isolated generator/controller tests. Only test-owned loopback fake workers run."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('generator',HERE/'generate.py')
gen=importlib.util.module_from_spec(spec);spec.loader.exec_module(gen)
FAKE_C=r'''
#include <arpa/inet.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc,char **argv) {
 const char *log=getenv("FAILOVER_TEST_LOG");FILE *f=fopen(log,"a");if(f){fprintf(f,"%s %ld\n",argc>1?argv[1]:"?",(long)getpid());fclose(f);}
 if(argc!=4||strcmp(argv[2],"-c"))return 2;
 if(!strcmp(argv[1],"check"))return getenv("FAILOVER_CHECK_FAIL")?1:0;
 if(strcmp(argv[1],"run"))return 2;
 char buf[16384];f=fopen(argv[3],"r");if(!f)return 3;size_t n=fread(buf,1,sizeof(buf)-1,f);fclose(f);buf[n]=0;
 char *p=strstr(buf,"\"listen_port\"");if(!p)return 4;int port=atoi(strchr(p,':')+1);
 int sock=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in sa={.sin_family=AF_INET,.sin_port=htons(port)};inet_pton(AF_INET,"127.0.0.1",&sa.sin_addr);
 if(bind(sock,(void*)&sa,sizeof(sa))||listen(sock,4))return 5;
 while(1)pause();
}
'''

def source():
    def reality(tag):return {'type':'vless','tag':tag,'server':'192.0.2.10','server_port':443,'uuid':'00000000-0000-4000-8000-000000000000','flow':'xtls-rprx-vision','tls':{'enabled':True,'server_name':'example.com','utls':{'enabled':True,'fingerprint':'chrome'},'reality':{'enabled':True,'public_key':'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','short_id':'0102030405060708'}}}
    def hy2(tag):return {'type':'hysteria2','tag':tag,'server':'192.0.2.20','server_port':443,'password':'SYNTHETIC_FIXTURE_SECRET','tls':{'enabled':True,'server_name':'example.com'}}
    return {'log':{'level':'warn'},'dns':{'servers':[{'type':'tls','tag':'zgo-dns','server':'1.1.1.1','detour':'zgo-netflix'}]},
        'inbounds':[{'type':'tun','tag':'tun-in','interface_name':'tun0','address':['172.19.0.1/30'],'auto_route':True,'include_uid':[10075,10076,10082]},
                    {'type':'direct','tag':'dns-in','listen':'127.0.0.1','listen_port':5354},
                    {'type':'socks','tag':'old-rack','listen':'127.0.0.1','listen_port':1080},
                    {'type':'socks','tag':'old-zgo','listen':'127.0.0.1','listen_port':1081}],
        'outbounds':[hy2('hy2'),reality('reality'),reality('zgo-netflix'),hy2('zgo-hy2'),{'type':'direct','tag':'direct'},
                     {'type':'urltest','tag':'auto','outbounds':['hy2','reality'],'url':'https://www.youtube.com/generate_204'},
                     {'type':'selector','tag':'zgo-video','outbounds':['zgo-hy2','zgo-netflix'],'default':'zgo-hy2'}],
        'route':{'rules':[{'inbound':['tun-in'],'domain_suffix':['nflxvideo.net'],'outbound':'zgo-video'},{'action':'sniff'},{'protocol':'dns','action':'hijack-dns'},
                          {'domain_suffix':['google.com'],'outbound':'zgo-netflix'},
                          {'domain_suffix':['nflxvideo.net'],'outbound':'zgo-video'},
                          {'user_id':[10076,10082],'invert':True,'outbound':'zgo-netflix'}],'final':'auto','default_mark':255},
        'experimental':{'clash_api':{'external_controller':'127.0.0.1:19090','secret':'SYNTHETIC_API_SECRET'}}}

class Tests:
    def __init__(self):
        self.tmp=Path(tempfile.mkdtemp(prefix='youtube-runtime-tests-'));self.count=0;self.roots=[];self.pids=set()
        self.fake=self.tmp/'fake-sing-box';c=self.tmp/'fake.c';c.write_text(FAKE_C)
        subprocess.run(['cc','-O2','-Wall','-Wextra','-o',str(self.fake),str(c)],check=True)
        bb=self.tmp/'busybox';bb.write_text('#!/bin/sh\nexec "$@"\n');bb.chmod(0o700);self.bb=bb
    def check(self,condition,message):
        if not condition:raise AssertionError(message)
        self.count+=1;print('PASS '+message,flush=True)
    def fixture(self,name):
        root=self.tmp/name
        scripts={n:(HERE/n).read_bytes() for n in ['workerctl.sh','worker-safe-check.sh']}
        contents=gen.assemble(source(),{'youtube':10076,'smarttube':10082},str(root),scripts)
        gen.write_release(root,contents);self.roots.append(root)
        # The fake read-only API checker is an explicit test replacement; it
        # records invocation and rejects if the simulated lane is still in use.
        (root/'worker-safe-check.sh').write_text('#!/bin/sh\nprintf "safe %s\\n" "$1" >> "$YOUTUBE_FAILOVER_ROOT/test-events"\n[ ! -e "$YOUTUBE_FAILOVER_ROOT/lane-busy" ]\n')
        (root/'worker-safe-check.sh').chmod(0o700)
        (root/'test-boot-id').write_text('boot-current\n');(root/'test-events').write_text('')
        return root
    def env(self,root):return {**os.environ,'YOUTUBE_FAILOVER_ROOT':str(root),'YOUTUBE_FAILOVER_BUSYBOX':str(self.bb),'YOUTUBE_FAILOVER_SING_BOX':str(self.fake),'YOUTUBE_FAILOVER_BOOT_ID_FILE':str(root/'test-boot-id'),'FAILOVER_TEST_LOG':str(root/'test-events')}
    def run(self,root,action,worker='rack',extra=None):
        env=self.env(root);env.update(extra or {})
        p=subprocess.run(['/bin/sh',str(root/'workerctl.sh'),action,worker],env=env,capture_output=True,text=True,timeout=25)
        self.remember(root)
        return p
    def authorize(self,root,boot='boot-current',release=None):
        for name,value in [('enabled',release or (root/'release-id').read_text().strip()),('authorized-boot-id',boot)]:
            (root/name).write_text(value+'\n');(root/name).chmod(0o600)
    def remember(self,root):
        for state in root.glob('workers/*/worker.pid'):
            try:self.pids.add(int(state.read_text().split('|')[1]))
            except (ValueError,IndexError):pass
    def alive(self,pid):
        try:return Path('/proc',str(pid),'stat').read_text().split(') ',1)[1].split()[0]!='Z'
        except FileNotFoundError:return False
    def wait(self,fn,seconds=3):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            if fn():return True
            time.sleep(.02)
        return False
    def stop_test_pid(self,pid):
        if not self.alive(pid):return
        self.check(os.readlink('/proc/'+str(pid)+'/exe')==str(self.fake),'test cleanup targets only its own compiled fake worker executable')
        os.kill(pid,signal.SIGTERM);self.wait(lambda:not self.alive(pid))
    def close(self):
        for root in self.roots:self.remember(root)
        for pid in self.pids:
            if self.alive(pid) and os.readlink('/proc/'+str(pid)+'/exe')==str(self.fake):os.kill(pid,signal.SIGTERM)
        self.wait(lambda:not any(self.alive(pid) for pid in self.pids))
        if any(self.alive(pid) for pid in self.pids):raise AssertionError('fake worker left alive')
        shutil.rmtree(self.tmp);print('PASS cleanup: every owned fake worker stopped, all fixtures removed',flush=True)
    def test(self):
        src=source();unchanged=copy.deepcopy(src);files,secret,release=gen.build(src,{'youtube':10076,'smarttube':10082})
        main=files['main-config.json'];out={o['tag']:o for o in main['outbounds']}
        self.check(src==unchanged,'generator leaves source config and credentials untouched in memory')
        self.check(main['inbounds'][:len(src['inbounds'])]==src['inbounds'],'generator preserves original TUN, UID list, DNS 5354 and SOCKS 1080/1081 inbounds exactly')
        self.check(main['outbounds'][:len(src['outbounds'])]==src['outbounds'],'generator retains original auto, both original HY2 sessions and Netflix selector/outbounds exactly')
        yt=out['youtube-video'];self.check(yt['outbounds']==[c[0] for c in gen.CANDIDATES] and yt['default']=='yt-rack-reality' and yt['interrupt_exist_connections'] is False,'media selector uses exact four-lane order, safe Reality initial choice and preserves existing media connections')
        self.check(out['dns-uplink']['default']=='dns-zgo-reality' and out['dns-uplink']['interrupt_exist_connections'] is True,'independent DNS selector starts on ZGO Reality and interrupts stale DNS connections on switch')
        rules=main['route']['rules'];uid_index=next(i for i,r in enumerate(rules) if r.get('outbound')=='youtube-video')
        self.check(rules[:3]==src['route']['rules'][:3] and rules[uid_index]['user_id']==[10076,10082] and rules[uid_index+1:]==src['route']['rules'][3:],'real production Netflix CDN prefix and sniff/hijack are preserved; UID route then precedes broad Google rules')
        self.check({i['listen_port']:i['listen'] for i in main['inbounds'][4:]}=={p:'127.0.0.1' for p in [19101,19102,19103,19104,19111,19112]},'all six fixed probe inbounds bind only loopback at assigned ports')
        self.check(main['dns']['servers'][0]['detour']=='dns-uplink' and main['dns']['servers'][0]['server']=='1.1.1.1','original DoT resolver changes only detour to independent DNS selector')
        self.check(files['guard-config.json']['dns']['server_ip']=='1.1.1.1' and files['guard-config.json']['dns']['server_name']=='1.1.1.1' and 'tls' not in main['dns']['servers'][0],'DoT without explicit TLS name uses actual numeric server identity; no invented SNI or TLS validation bypass')
        named=source();named['dns']['servers'][0]['tls']={'enabled':True,'server_name':'one.one.one.one'}
        named_files,_,_=gen.build(named,{'youtube':10076,'smarttube':10082})
        self.check(named_files['guard-config.json']['dns']['server_ip']=='1.1.1.1' and named_files['guard-config.json']['dns']['server_name']=='one.one.one.one' and named_files['main-config.json']['dns']['servers'][0]['tls']==named['dns']['servers'][0]['tls'],'explicit production DoT TLS server_name takes precedence while main TLS verification settings are preserved')
        for name,port,tag in [('rack',19201,'hy2'),('zgo',19202,'zgo-hy2')]:
            w=files['workers/'+name+'/config.json'];ob=w['outbounds'][0]
            self.check(w['inbounds']==[{'type':'socks','tag':'worker-in','listen':'127.0.0.1','listen_port':port}] and 'experimental' not in w,f'{name} worker has only independent loopback SOCKS, no TUN or shared management API')
            self.check(ob['password']=='SYNTHETIC_FIXTURE_SECRET' and ob['bind_interface']=='eth0' and ob['routing_mark']==255 and w['route']['default_mark']==255,f'{name} worker inherits source HY2 credential only in protected config and binds marked eth0 transport')
            self.check(w['dns']['servers'][0]['detour']=='worker-direct' and all('5354' not in json.dumps(v) for v in w.values()),f'{name} worker bootstrap cannot depend recursively on main DNS or its own HY2 session')
        root=self.fixture('inactive')
        self.check(not (root/'enabled').exists() and not (root/'authorized-boot-id').exists(),'generated release contains no activation or boot authorization marker')
        self.check(json.loads((root/'guard-config.json').read_text())['dry_run'] is False and json.loads((root/'guard-observe.json').read_text())['dry_run'] is True,'active and observation guard configs are distinct and both remain gated by absent markers')
        self.check(all(stat.S_IMODE(p.stat().st_mode)==(0o700 if p.is_dir() or p.suffix=='.sh' else 0o600) for p in [root,*root.rglob('*')] if p.name not in ['test-events','test-boot-id']),'release files are 0600, directories and executable scripts 0700')
        before={str(p.relative_to(root)):(p.stat().st_mtime_ns,p.read_bytes()) for p in root.rglob('*') if p.is_file()}
        r=self.run(root,'status');self.check(r.returncode==0 and json.loads(r.stdout)['authorized'] is False and json.loads(r.stdout)['status']=='stopped','inactive status is explicit, successful and read-only')
        self.check(before=={str(p.relative_to(root)):(p.stat().st_mtime_ns,p.read_bytes()) for p in root.rglob('*') if p.is_file()},'inactive status creates no lock, runtime state, logs or authorization data')
        self.check(self.run(root,'check').returncode==0 and 'run ' not in (root/'test-events').read_text(),'inactive check validates actual config without starting worker')
        for command in ['start','stop','restart']:
            self.check(self.run(root,command).returncode==1 and not (root/'workers/rack/control.lock').exists(),f'inactive {command} is rejected before lock or process mutation')
        self.authorize(root,boot='previous-boot')
        self.check(self.run(root,'start').returncode==1,'boot authorization from another boot cannot activate worker')
        self.authorize(root,release='different-release')
        self.check(self.run(root,'start').returncode==1,'enabled marker for another release cannot activate worker')
        self.authorize(root);(root/'enabled').chmod(0o666)
        self.check(self.run(root,'start').returncode==1,'world-writable activation marker is rejected')
        (root/'enabled').chmod(0o600)
        cfg=root/'workers/rack/config.json';old=cfg.read_bytes();cfg.write_bytes(old+b' ')
        self.check(self.run(root,'start').returncode==1,'config digest mismatch blocks process start')
        cfg.write_bytes(old)
        self.check(self.run(root,'start',extra={'FAILOVER_CHECK_FAIL':'1'}).returncode==1 and 'run ' not in (root/'test-events').read_text(),'sing-box check failure prevents start')
        with socket.socket() as conflict:
            conflict.bind(('127.0.0.1',19201));conflict.listen()
            self.check(self.run(root,'start').returncode==1 and json.loads(self.run(root,'status').stdout)['status']=='unmanaged_listener','unrelated process occupying worker port is preserved and start fails')
        r=self.run(root,'start');self.check(r.returncode==0,'authorized start creates a real isolated test worker')
        status=json.loads(self.run(root,'status').stdout);pid=status['pid'];self.pids.add(pid)
        self.check(status['status']=='running' and status['authorized'] is True and self.alive(pid),'status confirms exact executable, argv, boot, process starttime, config hash and owned socket')
        count=(root/'test-events').read_text().count('run ')
        self.check(self.run(root,'start').returncode==0 and (root/'test-events').read_text().count('run ')==count,'repeat start is idempotent without another worker or restart')
        (root/'lane-busy').touch()
        self.check(self.run(root,'restart').returncode==1 and self.alive(pid),'selected or still-referenced HY2 lane cannot be restarted')
        (root/'lane-busy').unlink()
        state=root/'workers/rack/worker.pid';valid=state.read_text();fields=valid.strip().split('|');fields[2]=str(int(fields[2])+1);state.write_text('|'.join(fields)+'\n')
        self.check(self.run(root,'stop').returncode==1 and self.alive(pid),'PID starttime mismatch prevents any signal to a potentially reused PID')
        state.write_text(valid)
        self.check(self.run(root,'restart').returncode==0,'authorized restart succeeds only after independent API safety check')
        newpid=json.loads(self.run(root,'status').stdout)['pid'];self.pids.add(newpid)
        self.check(newpid!=pid and not self.alive(pid) and self.alive(newpid),'restart stops only the identified old worker and launches one replacement')
        self.check(self.run(root,'start','zgo').returncode==0,'second HY2 worker starts as a separate process and session')
        zgo=json.loads(self.run(root,'status','zgo').stdout)['pid'];self.pids.add(zgo)
        self.check(zgo!=newpid and self.run(root,'stop').returncode==0 and self.alive(zgo),'stopping Rack worker preserves independent ZGO worker')
        self.check(self.run(root,'stop','zgo').returncode==0 and not self.alive(zgo),'authorized ZGO stop terminates only its exact own process')
        lock=root/'workers/rack/control.lock';lock.mkdir(mode=0o700)
        count=(root/'test-events').read_text().count('run ')
        self.check(self.run(root,'start').returncode==1 and (root/'test-events').read_text().count('run ')==count,'existing control lock is never stolen, and no worker mutation occurs')
        lock.rmdir()
        # Boot transitions and stale locks use real live child PIDs as reuse
        # sentinels; the controller must never send a signal to those children.
        outsider=subprocess.Popen(['/usr/bin/sleep','30'])
        try:
            outsider_start=Path('/proc',str(outsider.pid),'stat').read_text().split(') ',1)[1].split()[19]
            lock=root/'workers/rack/control.lock';lock.mkdir(mode=0o700)
            owner=lock/'owner';owner.write_text('boot-current|'+str(outsider.pid)+'|'+outsider_start+'\n');owner.chmod(0o600)
            self.check(self.run(root,'start').returncode==1 and outsider.poll() is None,'live lock owner with exact PID/starttime is preserved and blocks new worker')
            owner.write_text('boot-previous|'+str(outsider.pid)+'|'+outsider_start+'\n')
            self.check(self.run(root,'start').returncode==0 and outsider.poll() is None,'previous-boot lock is reclaimed without signalling a reused live PID')
            self.check(self.run(root,'stop').returncode==0 and outsider.poll() is None,'worker stop after lock reclamation leaves reused unrelated PID alive')
            state=root/'workers/rack/worker.pid';digest=(root/'workers/rack/config.sha256').read_text().strip()
            state.write_text('|'.join(['boot-previous',str(outsider.pid),outsider_start,str(self.fake),str(root/'workers/rack/config.json'),digest])+'\n');state.chmod(0o600)
            self.check(self.run(root,'start').returncode==0 and outsider.poll() is None,'previous-boot worker state is cleared under authorization without signalling its reused live PID')
            active_state=state.read_text();parts=active_state.split('|');parts[0]='boot-previous';state.write_text('|'.join(parts))
            active_pid=int(parts[1]);self.pids.add(active_pid)
            self.check(self.run(root,'restart').returncode==1 and self.alive(active_pid) and state.read_text().startswith('boot-previous|'),'previous-boot state with a current matching process/listener is preserved and cannot trigger duplicate start')
            state.write_text(active_state);self.check(self.run(root,'stop').returncode==0,'restored identity permits exact cleanup of only the test worker')
        finally:
            outsider.terminate();outsider.wait(timeout=3)
        deceased=subprocess.Popen(['/usr/bin/sleep','0.1'])
        deceased_start=Path('/proc',str(deceased.pid),'stat').read_text().split(') ',1)[1].split()[19]
        deceased.wait(timeout=3)
        lock=root/'workers/rack/control.lock';lock.mkdir(mode=0o700)
        owner=lock/'owner';owner.write_text('boot-current|'+str(deceased.pid)+'|'+deceased_start+'\n');owner.chmod(0o600)
        self.check(self.run(root,'start').returncode==0,'same-boot lock whose exact owner has died is safely reclaimed')
        self.check(self.run(root,'stop').returncode==0,'worker remains independently stoppable after dead-lock-owner recovery')
        self.check(self.run(root,'start').returncode==0,'crash-recovery fixture starts a genuine owned worker')
        crashed=json.loads(self.run(root,'status').stdout)['pid'];self.pids.add(crashed)
        self.stop_test_pid(crashed)
        self.check(self.run(root,'restart').returncode==0,'same-boot crashed/zombie own worker record is safely removed and replacement starts')
        repaired=json.loads(self.run(root,'status').stdout)['pid'];self.pids.add(repaired)
        self.check(repaired!=crashed and self.alive(repaired),'crash recovery creates a live new process, not merely a success status')
        self.check(self.run(root,'stop').returncode==0,'recovered worker remains cleanly stoppable through safety gate')
        bad=source();bad['route']['rules'][0]['domain_suffix']=['google.com']
        try:gen.build(bad,{'youtube':10076});rejected=False
        except gen.InvalidInput:rejected=True
        self.check(rejected,'traffic-catching non-Netflix prefix before sniff is rejected')
        bad=source();bad['inbounds'][0]['include_uid'].remove(10082)
        try:gen.build(bad,{'youtube':10076,'smarttube':10082});rejected=False
        except gen.InvalidInput:rejected=True
        self.check(rejected,'UID absent from existing TUN is rejected rather than silently rewriting Netflix/TUN scope')
        bad=source();bad['inbounds'].append({'type':'socks','listen_port':19101})
        try:gen.build(bad,{'youtube':10076});rejected=False
        except gen.InvalidInput:rejected=True
        self.check(rejected,'reserved probe-port collision fails generation')
        # A real supported sing-box parses every generated config; check never run.
        native=Path('/tmp/video-proxy/sing-box-1.14.3-linux-amd64/sing-box')
        if not native.is_file():raise AssertionError('required native sing-box 1.14.3 check binary absent')
        for name in ['main-config.json','workers/rack/config.json','workers/zgo/config.json']:
            r=subprocess.run([str(native),'check','-c',str(root/name)],capture_output=True,text=True,timeout=10)
            self.check(r.returncode==0,'real sing-box 1.14.3 validates '+name+' without starting any listener: '+r.stderr.strip()[:120])
        print('PASS all '+str(self.count)+' explicit runtime assertions',flush=True)

if __name__=='__main__':
    tests=Tests()
    try:tests.test()
    finally:tests.close()
