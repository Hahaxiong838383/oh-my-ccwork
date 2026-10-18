#!/usr/bin/env python3
"""Run production boot shell copies using fake clock/network/iptables and real flock.

No ADB, real date-setting, real routing, or actual proxy is invoked. The only
background service is a sleep owned by a fixture and always reaped/terminated.
Usage: python3 test_boot_flow.py --source-dir /path/to/video-proxy-boot
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

MOCK = r'''#!/usr/bin/python3
import json, os, pathlib, sys, time
p = pathlib.Path(os.environ['BOOT_TEST_FIXTURE'])
cmd = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
opts = json.loads((p/'options.json').read_text())
def emit(action, **extra):
    item = {'action': action, 'cmd': cmd, 'args': args, 'pid': os.getpid(), **extra}
    fd = os.open(p/'events.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.write(fd, (json.dumps(item)+'\n').encode()); os.close(fd)
def scalar(name, default='0'):
    f=p/name
    return f.read_text().strip() if f.exists() else default
def put(name, value): (p/name).write_text(str(value))
def counter(name):
    n=int(scalar(name))+1; put(name,n); return n
if cmd == 'cat':
    if args == ['/proc/sys/kernel/random/boot_id']:
        emit('boot_id.read'); print(opts.get('boot_id','next-boot')); sys.exit(0)
    os.execv('/usr/bin/cat', ['cat', *args])
elif cmd == 'cut':
    if '/proc/uptime' in args:
        print('12.00'); sys.exit(0)
    os.execv('/usr/bin/cut', ['cut', *args])
elif cmd == 'date':
    if len(args)==2 and args[0]=='-u' and args[1].startswith('@'):
        emit('clock.set', epoch=int(args[1][1:]))
        if opts.get('clock_set_fail'): sys.exit(1)
        put('clock',args[1][1:]); print('clock updated'); sys.exit(0)
    if args == ['+%s']:
        emit('clock.read'); print(scalar('clock','1709136000')); sys.exit(0)
    emit('clock.format'); print('2026-10-18T00:00:00Z'); sys.exit(0)
elif cmd == 'getprop':
    n=counter('getprop.calls'); completed = n > opts.get('boot_waits',2)
    emit('boot_completed.read', completed=completed)
    print('1' if completed else '0'); sys.exit(0)
elif cmd == 'sleep':
    emit('retry.sleep')
    if args == ['30'] and opts.get('hold_retry'): time.sleep(90)
    if args == ['10'] and opts.get('hold_cache_retry') and scalar('cache.failed')=='1': time.sleep(90)
    sys.exit(0)
elif cmd == 'pidof':
    alive = bool(opts.get('existing_proxy'))
    if opts.get('appears_before_start') and counter('pidof.calls') >= 2: alive=True
    emit('proxy.exists', exists=alive)
    if alive: print('424242')
    sys.exit(0 if alive else 1)
elif cmd == 'ip':
    if args[:3] == ['-4','addr','show']:
        emit('interface.check'); print('    inet 192.0.2.10/24 scope global eth0'); sys.exit(0)
    if args[:3] == ['-4','route','get']:
        emit('route.check'); sys.exit(0)
    if args[:3] == ['rule','del','pref']:
        emit('route.rule.delete'); sys.exit(0)
    raise RuntimeError('unexpected ip arguments '+repr(args))
elif cmd in ('iptables','ip6tables'):
    normalized = args[2:] if args[:2]==['-t','nat'] else args
    action, chain = normalized[:2]
    emit('firewall.command', family=cmd, operation=action, chain=chain)
    jump_file = cmd+'.jump'
    if action == '-C' and chain == 'OUTPUT': sys.exit(0 if scalar(jump_file)=='1' else 1)
    if action == '-D' and chain == 'OUTPUT':
        if scalar(jump_file)=='1': put(jump_file,'0'); sys.exit(0)
        sys.exit(1)
    if action == '-A' and chain == 'OUTPUT':
        if opts.get('rule_fail') == cmd: sys.exit(1)
        put(jump_file,'1')
    sys.exit(0)
elif cmd == 'settings':
    emit('settings.write'); sys.exit(0)
elif cmd == 'readlink':
    pid=scalar('owned.pid','')
    if pid and args == ['/proc/'+pid+'/exe']:
        emit('owned_executable.check'); print(str(p/'device'/'sing-box')); sys.exit(0)
    os.execv('/usr/bin/readlink',['readlink',*args])
elif cmd == 'busybox':
    if args and args[0]=='flock':
        emit('lock.enter'); os.execv('/usr/bin/flock',['flock',*args[1:]])
    if args and args[0]=='nohup':
        emit('background.spawn'); os.execvp(args[1],args[1:])
    if args and args[0]=='awk':
        os.execv('/usr/bin/awk',['awk',*args[1:]])
    raise RuntimeError('unexpected busybox arguments '+repr(args))
elif cmd == 'dumpsys':
    if args != ['dnsresolver']: raise RuntimeError('unexpected dumpsys arguments')
    n=counter('resolver.dumps'); emit('cache.networks.list')
    if opts.get('dumpsys_fail'):
        put('cache.failed','1'); sys.exit(1)
    if opts.get('malformed_netid'):
        put('cache.failed','1'); print('NetId: broken'); sys.exit(0)
    ids=opts.get('network_ids',[101])
    if opts.get('later_network_ids') and n>1: ids=opts['later_network_ids']
    for netid in ids:
        print('NetId: '+str(netid)); print('  DnsEvent subscriptions=0')
    if not ids: put('cache.failed','1')
    sys.exit(0)
elif cmd == 'app_process':
    if args[:2] != ['/system/bin','VideoDnsCache'] or len(args)<3:
        raise RuntimeError('unexpected app_process invocation')
    expected_classpath=str(p/'device'/'video-dns-cache.dex')+':/system/framework/services.jar'
    if os.environ.get('CLASSPATH')!=expected_classpath: raise RuntimeError('missing platform services classpath')
    if args[2:3]==['--resolve']:
        if len(args)!=4 or args[3] not in ('www.youtube.com','ntp3.aliyun.com'):
            raise RuntimeError('unexpected system resolver arguments')
        n=counter('system.resolve.calls')
        clean=not json.loads((p/'resolver-cache.json').read_text()) and not json.loads((p/'app-cache.json').read_text())
        good=clean and not opts.get('system_resolver_fail') and n>opts.get('system_resolver_fail_until',0)
        emit('cache.system.resolve',good=good,host=args[3])
        if not good: put('cache.failed','1'); sys.exit(1)
        print('SYSTEM_DNS_OK host='+args[3]+' address=142.251.157.4'); sys.exit(0)
    ids=[int(i) for i in args[2:]]
    n=counter('cache.flush.calls'); good=not opts.get('cache_flush_fail') and n>opts.get('cache_flush_fail_until',0)
    emit('cache.netd.flush', network_ids=ids, good=good)
    if not good: put('cache.failed','1'); sys.exit(1)
    cache=json.loads((p/'resolver-cache.json').read_text())
    for netid in ids: cache.pop(str(netid),None)
    (p/'resolver-cache.json').write_text(json.dumps(cache)); sys.exit(0)
elif cmd == 'am':
    if args != ['broadcast','--user','all','-a','android.intent.action.CLEAR_DNS_CACHE']:
        raise RuntimeError('unexpected application command')
    n=counter('cache.broadcast.calls'); good=not opts.get('broadcast_fail') and n>opts.get('broadcast_fail_until',0)
    emit('cache.apps.broadcast', good=good)
    if not good: put('cache.failed','1'); sys.exit(1)
    (p/'app-cache.json').write_text('{}'); print('Broadcast completed: result=0'); sys.exit(0)
elif cmd == 'video-boot-net':
    if args[:2] == ['time','eth0']:
        emit('ntp.query')
        n=counter('ntp.calls')
        if opts.get('ntp_fail') or n <= opts.get('ntp_fail_until',0): sys.exit(1)
        if opts.get('hold_ntp'): time.sleep(0.5)
        print('1792281600'); sys.exit(0)
    if args[:1] == ['dns']:
        # Ensure probe host, destination, and DNS port really match production.
        if len(args)!=4 or args[1] not in ('www.youtube.com','ntp3.aliyun.com') or args[2:]!=['127.0.0.1','5354']:
            raise RuntimeError('wrong DNS probe target '+repr(args))
        n=counter('dns.calls')
        proxy_ready = (p/'owned.pid').exists()
        ready_n = counter('dns.ready.calls') if proxy_ready else 0
        good = proxy_ready and not opts.get('dns_fail') and not (opts.get('post_dns_fail') and ready_n >= 3)
        if opts.get('late_dns_fail') and ready_n>=4:
            good=False; put('cache.failed','1')
        emit('dns.query', good=good, host=args[1])
        sys.exit(0 if good else 1)
    raise RuntimeError('unexpected helper arguments '+repr(args))
elif cmd == 'sing-box':
    if args[:1] == ['check']:
        emit('proxy.config.check'); sys.exit(0)
    if args[:1] == ['run']:
        emit('proxy.run'); put('owned.pid',os.getpid())
        with (p/'owned.pids').open('a') as history: history.write(str(os.getpid())+'\n')
        # exec preserves this owned PID; production stop_owned_proxy kills only it.
        os.execv('/usr/bin/sleep',['sleep','90'])
    raise RuntimeError('unexpected proxy arguments '+repr(args))
else:
    raise RuntimeError('unhandled mock '+cmd)
'''

class Suite:
    def __init__(self, source):
        self.source = source.resolve()
        self.tmp = Path(tempfile.mkdtemp(prefix='video-boot-flow-tests-'))
        self.count = 0
        self.fixtures = []
        self.hashes = {n: hashlib.sha256((source/n).read_bytes()).hexdigest()
                       for n in ['video-boot-start.sh','video-proxy.sh']}
    def check(self, cond, message):
        if not cond:
            raise AssertionError(message)
        self.count += 1
        print('PASS '+message, flush=True)
    def fixture(self, name, **opts):
        p=self.tmp/name; p.mkdir(); self.fixtures.append(p)
        d=p/'device'; d.mkdir(); b=p/'bin'; b.mkdir()
        (p/'options.json').write_text(json.dumps(opts))
        (p/'events.jsonl').write_text('')
        (p/'clock').write_text('1709136000')
        (d/'config.json').write_text('{}')
        (d/'video-dns-cache.dex').write_bytes(b'fixture dex')
        ids=opts.get('network_ids',[101])+opts.get('later_network_ids',[])
        (p/'resolver-cache.json').write_text(json.dumps({str(i):'185.45.5.35' for i in ids}))
        (p/'app-cache.json').write_text(json.dumps({'www.youtube.com':'185.45.5.35'}))
        if not opts.get('missing_installed'):
            (d/'boot-fix-installed-boot-id').write_text(opts.get('installed_id','install-boot')+'\n')
        mock=b/'mock_dispatch'; mock.write_text(MOCK); mock.chmod(0o755)
        for cmd in ('cat','cut','date','getprop','sleep','pidof','ip','iptables','ip6tables','settings','readlink','busybox','dumpsys','app_process','am'):
            (b/cmd).symlink_to(mock)
        for cmd in ('video-boot-net','sing-box'):
            (d/cmd).symlink_to(mock)
        for filename in self.hashes:
            source=(self.source/filename).read_text()
            if filename=='video-proxy.sh':
                if source.count('D=/data/adb/video-proxy')!=1 or source.count('/data/adb/magisk/busybox')!=1:
                    raise AssertionError('production entry shape changed; review fixture substitution')
                source=source.replace('D=/data/adb/video-proxy', 'D='+str(d))
                source=source.replace('/data/adb/magisk/busybox',str(b/'busybox'))
            (d/filename).write_text(source)
        return p
    def env(self,p):
        return {**os.environ,'PATH':str(p/'bin')+':/usr/bin:/bin',
                'VIDEO_PROXY_BUSYBOX':str(p/'bin'/'busybox'),'BOOT_TEST_FIXTURE':str(p)}
    def run(self,p,entry=False):
        name='video-proxy.sh' if entry else 'video-boot-start.sh'
        result=subprocess.run(['/bin/sh',str(p/'device'/name)],env=self.env(p),capture_output=True,text=True,timeout=15)
        if result.returncode not in (0,1):
            raise AssertionError(f'{p.name}: unexpected rc={result.returncode}: {result.stderr}')
        return result
    def until_retry(self,p,delay='30'):
        proc=subprocess.Popen(['/bin/sh',str(p/'device'/'video-boot-start.sh')],env=self.env(p),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        try:
            observed=self.wait_for(p,lambda:any(e['action']=='retry.sleep' and e['args']==[delay] and (delay=='30' or (p/'cache.failed').exists()) for e in self.events(p)),timeout=15)
            if not observed: raise AssertionError(p.name+': retry backoff was never reached')
            (p/'owned-alive-at-retry').write_text('yes' if self.alive(p) else 'no')
        finally:
            if proc.poll() is None: os.killpg(proc.pid,signal.SIGTERM)
            proc.communicate(timeout=5)
        return proc.returncode
    def events(self,p):
        return [json.loads(line) for line in (p/'events.jsonl').read_text().splitlines()]
    def actions(self,p): return [e['action'] for e in self.events(p)]
    def no_mutation(self,p):
        events=self.events(p)
        banned={'clock.set','background.spawn','proxy.run','firewall.command','settings.write','route.rule.delete','cache.netd.flush','cache.apps.broadcast'}
        return not any(e['action'] in banned for e in events)
    def log(self,p):
        file=p/'device'/'boot-start.log'
        return file.read_text() if file.exists() else ''
    def wait_for(self,p,predicate,timeout=5):
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            if predicate(): return True
            time.sleep(0.02)
        return False
    def alive(self,p):
        file=p/'owned.pid'
        if not file.exists(): return False
        stat=Path('/proc')/file.read_text().strip()/'stat'
        if not stat.exists(): return False
        try: return stat.read_text().split()[2] != 'Z'
        except FileNotFoundError: return False
    def clean(self):
        for p in self.fixtures:
            pidfile=p/'owned.pid'
            if pidfile.exists():
                pid=int(pidfile.read_text())
                # Verify cmdline from this fixture's known fake service before kill.
                try:
                    if Path('/proc',str(pid),'cmdline').read_bytes()==b'sleep\x0090\x00':
                        os.kill(pid,signal.SIGTERM)
                except ProcessLookupError: pass
                except FileNotFoundError: pass
        deadline=time.monotonic()+3
        while any(self.alive(p) for p in self.fixtures) and time.monotonic()<deadline: time.sleep(0.02)
        if any(self.alive(p) for p in self.fixtures): raise AssertionError('owned fake proxy remained alive after cleanup')
        shutil.rmtree(self.tmp)
        print('PASS test cleanup: every fixture-owned fake proxy is stopped and temporary fixtures are removed',flush=True)
    def test(self):
        for entry in (False,True):
            target='service.d entry' if entry else 'boot worker'
            for name,opts in [('same_boot',{'boot_id':'install-boot'}),('missing_boot',{'boot_id':''}),('missing_installed',{'missing_installed':True})]:
                p=self.fixture(('entry_' if entry else 'worker_')+name,**opts)
                r=self.run(p,entry)
                self.check(r.returncode==0 and 'deferred until next boot' in r.stdout,f'{target}: {name} exits at reboot barrier')
                self.check(self.no_mutation(p) and self.actions(p)==['boot_id.read'],f'{target}: {name} performs zero clock, proxy, DNS, firewall or settings changes')
        p=self.fixture('success')
        self.check(self.run(p).returncode==0,'next boot: complete successful production shell execution')
        events=self.events(p); actions=self.actions(p)
        completed=next(i for i,e in enumerate(events) if e['action']=='boot_completed.read' and e['completed'])
        self.check(sum(e['action']=='boot_completed.read' and not e['completed'] for e in events)==2,'next boot: waits while Android boot_completed is false')
        first_fw=actions.index('firewall.command')
        self.check(completed < actions.index('ntp.query') < actions.index('clock.set') < actions.index('proxy.run') < next(i for i,e in enumerate(events) if e['action']=='dns.query' and e['good']) < first_fw,
                   'next boot: boot_completed → NTP → clock set → proxy start → DNS answers → firewall rules')
        pre_dns=[e for e in events[:first_fw] if e['action']=='dns.query']
        self.check({e['host'] for e in pre_dns if e['good']}=={'www.youtube.com','ntp3.aliyun.com'},'next boot: both expected hosts give valid DNS answers on 127.0.0.1:5354 before takeover')
        self.check((p/'device'/'boot-ready-boot-id').read_text().strip()=='next-boot' and 'dns_takeover_ready' in self.log(p),'next boot: ready marker committed only after complete rule installation and DNS recheck')
        pre_cache_dns=max(i for i,e in enumerate(events[:actions.index('cache.netd.flush')]) if e['action']=='dns.query')
        self.check(pre_cache_dns < actions.index('cache.netd.flush') < actions.index('cache.apps.broadcast'), 'cached boot-time pollution: post-takeover 5354 response precedes netd flush and all-user app cache broadcast')
        self.check(not json.loads((p/'resolver-cache.json').read_text()) and not json.loads((p/'app-cache.json').read_text()), 'cached boot-time pollution: stale netd and application entries are both removed')
        self.check(self.log(p).index('dns_caches_flushed') < self.log(p).index('dns_takeover_ready'), 'cached boot-time pollution: completion is recorded only after both cache layers succeed')
        resolves=[e for e in events if e['action']=='cache.system.resolve']
        self.check({e['host'] for e in resolves if e['good']}=={'www.youtube.com','ntp3.aliyun.com'} and actions.index('cache.apps.broadcast') < actions.index('cache.system.resolve'), 'cached boot-time pollution: both names resolve through the system resolver only after broadcast')
        after_system=[e for e in events[max(i for i,e in enumerate(events) if e['action']=='cache.system.resolve')+1:] if e['action']=='dns.query']
        self.check({e['host'] for e in after_system if e['good']}=={'www.youtube.com','ntp3.aliyun.com'}, 'cached boot-time pollution: both 5354 queries are repeated after system resolution before readiness')
        before=len(events)
        self.check(self.run(p).returncode==1,'same successful boot with live proxy: inherited nonblocking flock rejects repeat call')
        repeat=self.events(p)[before:]
        self.check(not any(e['action'] in {'clock.set','background.spawn','proxy.run','firewall.command','settings.write','route.rule.delete'} for e in repeat) and 'already_completed' not in self.log(p),'same successful boot with live proxy: lock rejection causes zero clock, proxy, firewall or settings changes')
        owned=int((p/'owned.pid').read_text())
        self.check(Path('/proc',str(owned),'cmdline').read_bytes()==b'sleep\x0090\x00','completed-marker fixture: only its known fake proxy is selected for lock-release setup')
        os.kill(owned,signal.SIGTERM)
        self.check(self.wait_for(p,lambda:not self.alive(p)),'completed-marker fixture: fake proxy stops and releases inherited lock')
        before=len(self.events(p))
        self.check(self.run(p).returncode==0 and 'already_completed' in self.log(p),'same completed boot without held lock: ready-marker branch returns zero')
        self.check(not any(e['action'] in {'clock.set','background.spawn','proxy.run','firewall.command','settings.write','route.rule.delete'} for e in self.events(p)[before:]),'same completed boot without held lock: ready-marker branch never restarts proxy or rewrites rules')
        p=self.fixture('entry_success')
        self.check(self.run(p,entry=True).returncode==0,'next boot: service.d entry returns after background delegation')
        self.check(self.wait_for(p,lambda:(p/'device'/'boot-ready-boot-id').exists()),'next boot: service.d entry actually invokes worker and reaches ready marker')
        p=self.fixture('android_boot_late',boot_waits=90,hold_retry=True)
        self.check(self.until_retry(p)<0 and 'retry_later reason=android_boot_timeout' in self.log(p),'Android boot completion delayed: waits 90 checks then enters retry backoff')
        self.check(self.actions(p).count('boot_completed.read')==90 and self.no_mutation(p) and 'ntp.query' not in self.actions(p),'Android boot completion delayed: no time query, clock write, proxy start or DNS takeover')
        p=self.fixture('ntp_failure',ntp_fail=True,hold_retry=True)
        self.check(self.until_retry(p)<0 and 'retry_later reason=time_sources_unavailable_no_dns_takeover' in self.log(p),'NTP outage: enters 30-second retry backoff; harness terminates only its own fixture process group')
        self.check(self.actions(p).count('ntp.query')==12,'NTP outage: all 12 configured source attempts fail before giving up')
        self.check(self.no_mutation(p) and not (p/'device'/'boot-ready-boot-id').exists(),'NTP outage: no clock set, proxy start, DNS takeover, settings change or ready marker')
        p=self.fixture('ntp_recovery',ntp_fail_until=12)
        self.check(self.run(p).returncode==0,'NTP recovers after initial exhausted round: existing worker retries and completes')
        self.check(self.actions(p).count('ntp.query')==13 and self.actions(p).count('proxy.run')==1 and self.actions(p).count('lock.enter')==1,'NTP recovery: second round performs a new time query and starts one proxy under the original lock')
        self.check('retry_later reason=time_sources_unavailable_no_dns_takeover' in self.log(p) and (p/'device'/'boot-ready-boot-id').exists(),'NTP recovery: initial retry evidence and final completed boot marker both exist')
        p=self.fixture('dns_failure',dns_fail=True,hold_retry=True)
        self.check(self.until_retry(p)<0 and 'retry_later reason=dns_failed_no_takeover' in self.log(p),'DNS 5354 has no valid answer: enters 30-second retry backoff; harness terminates only its own fixture process group')
        self.check(self.actions(p).count('dns.query')==20 and 'proxy.run' in self.actions(p),'DNS 5354 has no valid answer: real shell exhausts 20 probes after starting owned fake proxy')
        self.check(not any(a in {'firewall.command','settings.write','route.rule.delete'} for a in self.actions(p)) and not (p/'device'/'boot-ready-boot-id').exists(),'DNS 5354 has no valid answer: never changes DNS rules/settings and never marks ready')
        self.check((p/'owned-alive-at-retry').read_text()=='no' and 'owned_executable.check' in self.actions(p),'DNS 5354 has no valid answer: owned proxy is already stopped before harness cleanup')
        for name,opts,reason in [('existing_proxy',{'existing_proxy':True},'existing_proxy_preserved'),('appeared_proxy',{'appears_before_start':True},'proxy_appeared_preserved')]:
            p=self.fixture(name,**opts); r=self.run(p)
            self.check(r.returncode==1 and reason in self.log(p),f'{name}: existing proxy is detected and preserved')
            self.check(not any(a in {'background.spawn','proxy.run','owned_executable.check','firewall.command','settings.write'} for a in self.actions(p)),f'{name}: no replacement process, termination or DNS takeover')
        p=self.fixture('rule_failure',rule_fail='ip6tables')
        self.check(self.run(p).returncode==1,'IPv6 OUTPUT rule installation fails: boot worker reports failure')
        events=self.events(p)
        self.check(any(e['action']=='firewall.command' and e['family']=='iptables' and e['operation']=='-A' and e['chain']=='OUTPUT' for e in events),'rule failure: IPv4 OUTPUT jump really was added before IPv6 failed')
        self.check((p/'iptables.jump').read_text()=='0' and not (p/'ip6tables.jump').exists(),'rule failure: removes its already-installed IPv4 jump and leaves no IPv6 jump')
        self.check(self.wait_for(p,lambda:not self.alive(p)) and not (p/'device'/'boot-ready-boot-id').exists(),'rule failure: owned proxy terminates and no ready marker is written')
        p=self.fixture('post_dns_failure',post_dns_fail=True)
        self.check(self.run(p).returncode==1,'DNS fails after takeover: final readback failure propagates')
        self.check((p/'iptables.jump').read_text()=='0' and (p/'ip6tables.jump').read_text()=='0','DNS fails after takeover: both installed OUTPUT jumps are removed')
        self.check(self.wait_for(p,lambda:not self.alive(p)) and not (p/'device'/'boot-ready-boot-id').exists(),'DNS fails after takeover: owned proxy stops and boot is not marked ready')
        self.check('cache.netd.flush' not in self.actions(p) and 'cache.apps.broadcast' not in self.actions(p), 'DNS fails after takeover: cache refresh is not attempted without healthy final DNS')
        p=self.fixture('dynamic_networks',network_ids=[107,235,4096,107])
        self.check(self.run(p).returncode==0, 'DNS cache: multiple runtime-derived network IDs complete')
        flush=next(e for e in self.events(p) if e['action']=='cache.netd.flush')
        self.check(set(flush['network_ids'])=={107,235,4096} and len(flush['network_ids'])==3, 'DNS cache: all actual NetIds are flushed once without assuming network 101')
        for name,opts,failed_action in [
            ('flush_unavailable',{'cache_flush_fail':True},'cache.netd.flush'),
            ('broadcast_unavailable',{'broadcast_fail':True},'cache.apps.broadcast'),
            ('resolver_dump_unavailable',{'dumpsys_fail':True},'cache.networks.list'),
            ('resolver_empty',{'network_ids':[]},'cache.networks.list'),
            ('resolver_malformed',{'malformed_netid':True},'cache.networks.list'),
            ('system_resolver_unavailable',{'system_resolver_fail':True},'cache.system.resolve')]:
            p=self.fixture(name,hold_cache_retry=True,**opts)
            self.check(self.until_retry(p,delay='10')<0 and 'dns_cache_retry attempt=1' in self.log(p), name+': cache failure enters its own in-place retry')
            self.check((p/'owned-alive-at-retry').read_text()=='yes' and (p/'iptables.jump').read_text()=='1' and (p/'ip6tables.jump').read_text()=='1', name+': healthy proxy and both installed DNS jumps remain active at retry')
            self.check(not (p/'device'/'boot-ready-boot-id').exists() and 'owned_executable.check' not in self.actions(p), name+': no completion marker and no proxy stop path')
            self.check(failed_action in self.actions(p), name+': configured failing service was actually invoked')
            if failed_action in {'cache.networks.list','cache.netd.flush'}:
                self.check('cache.apps.broadcast' not in self.actions(p),name+': application broadcast is withheld until netd flush succeeds')
        p=self.fixture('flush_recovers_changed_networks',network_ids=[107],later_network_ids=[107,235],cache_flush_fail_until=1)
        self.check(self.run(p).returncode==0, 'DNS cache recovery: failed flush retries successfully while a new network appears')
        flushes=[e for e in self.events(p) if e['action']=='cache.netd.flush']
        self.check(len(flushes)==2 and set(flushes[0]['network_ids'])=={107} and set(flushes[1]['network_ids'])=={107,235}, 'DNS cache recovery: retry re-reads the current network list')
        self.check(self.actions(p).count('proxy.run')==1 and self.actions(p).count('clock.set')==1 and self.actions(p).count('lock.enter')==1 and 'owned_executable.check' not in self.actions(p), 'DNS cache recovery: same clock, same proxy, same worker lock throughout retry')
        self.check(not json.loads((p/'resolver-cache.json').read_text()) and not json.loads((p/'app-cache.json').read_text()) and (p/'device'/'boot-ready-boot-id').exists(), 'DNS cache recovery: all stale entries cleared before successful completion')
        p=self.fixture('broadcast_recovers',broadcast_fail_until=1)
        self.check(self.run(p).returncode==0 and self.actions(p).count('cache.apps.broadcast')==2, 'application cache broadcast: transient failure is retried and completes')
        self.check(self.actions(p).count('proxy.run')==1 and (p/'device'/'boot-ready-boot-id').exists(), 'application cache broadcast: recovery preserves the one running proxy')
        p=self.fixture('system_resolver_recovers',system_resolver_fail_until=1)
        self.check(self.run(p).returncode==0 and self.actions(p).count('cache.system.resolve')==3, 'system resolver readback: a failed YouTube lookup retries, then both actual host lookups succeed')
        self.check(self.actions(p).count('proxy.run')==1 and 'owned_executable.check' not in self.actions(p) and (p/'device'/'boot-ready-boot-id').exists(), 'system resolver readback: recovery retains the healthy proxy and only then writes completion')
        p=self.fixture('proxy_dns_fails_during_cache',late_dns_fail=True,hold_cache_retry=True)
        self.check(self.until_retry(p,delay='10')<0 and 'dns_cache_retry attempt=1' in self.log(p), 'proxy DNS becomes unavailable during cache refresh: final query fails into the in-place retry')
        dns=[e for e in self.events(p) if e['action']=='dns.query']
        self.check(len([e for e in dns if e['good']])>=3 and not dns[-1]['good'] and self.actions(p).count('cache.system.resolve')==2, 'proxy DNS becomes unavailable during cache refresh: initial DNS and both system lookups passed before actual final probe failed')
        self.check((p/'owned-alive-at-retry').read_text()=='yes' and not (p/'device'/'boot-ready-boot-id').exists() and 'owned_executable.check' not in self.actions(p), 'proxy DNS becomes unavailable during cache refresh: preserves service while withholding readiness')
        p=self.fixture('clock_set_failure',clock_set_fail=True)
        self.check(self.run(p).returncode==1 and 'clock_set_failed' in self.log(p),'clock write fails: shell refuses to proceed')
        self.check(not any(a in {'proxy.run','background.spawn','firewall.command','settings.write'} for a in self.actions(p)),'clock write fails: proxy and takeover never start')
        p=self.fixture('concurrent_start',hold_ntp=True)
        cmd=['/bin/sh',str(p/'device'/'video-boot-start.sh')]
        a=subprocess.Popen(cmd,env=self.env(p),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.check(self.wait_for(p,lambda:'ntp.query' in self.actions(p)),'concurrency: first worker holds the actual flock during NTP')
        b=subprocess.run(cmd,env=self.env(p),capture_output=True,text=True,timeout=10)
        a_out,a_err=a.communicate(timeout=15)
        self.check(a.returncode==0 and b.returncode==1,'concurrency: real nonblocking flock allows one worker and rejects the competitor')
        self.check(self.actions(p).count('proxy.run')==1 and self.actions(p).count('clock.set')==1,'concurrency: exactly one owned proxy and one clock write across competing workers')
        self.check(all(hashlib.sha256((self.source/n).read_bytes()).hexdigest()==digest for n,digest in self.hashes.items()),'test safety: both production source files remain byte-for-byte unchanged')
        print(f'PASS all {self.count} explicit assertions; all fake service processes will be cleaned',flush=True)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir',type=Path,default=Path(__file__).resolve().parent)
    args=parser.parse_args(); suite=Suite(args.source_dir)
    try: suite.test()
    finally: suite.clean()
if __name__=='__main__': main()
