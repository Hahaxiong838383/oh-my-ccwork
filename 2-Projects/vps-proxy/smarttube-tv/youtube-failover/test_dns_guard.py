#!/usr/bin/env python3
"""Execute the production DNS/boot shell against a stateful firewall fixture.

No ADB or host firewall commands. Rule evaluation covers UDP/TCP, mark bypass,
missing NAT, lost/reordered netd hooks, installation barriers and startup retries.
It is not a substitute for cold-boot observation on the actual Android image.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

SOURCE = Path(__file__).resolve().parent
COUNT = 0


def check(condition, message):
    global COUNT
    assert condition, message
    COUNT += 1
    print('PASS', message, flush=True)


FIREWALL = r'''#!/usr/bin/python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ['DNS_GUARD_FIXTURE'])
cmd = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with (p/'firewall-events.jsonl').open('a') as f:
    f.write(json.dumps([cmd, args])+'\n')
state = json.loads((p/'firewall.json').read_text())
opts = json.loads((p/'firewall-options.json').read_text())
assert args[:1] == ['-t'], args
table, op, chain = args[1:4]
rules = args[4:]
key = cmd+':'+table
chains = state.setdefault(key, {'OUTPUT': []})
if opts.get('fail_table') == key and op in ('-N','-A','-I'):
    sys.exit(1)
if op == '-N':
    if chain in chains: sys.exit(1)
    chains[chain] = []
elif op == '-C': sys.exit(0 if rules in chains.get(chain, []) else 1)
elif op == '-S':
    if chain not in chains: sys.exit(1)
    lines=[]
    for r in chains[chain]:
        r=list(r)
        if '-p' in r:
            at=r.index('-p')+1
            r[at+1:at+1]=['-m',r[at]]
        if '--mark' in r: r[r.index('--mark')+1]='0xff'
        if r[-2:]==['-j','REJECT']:
            r+=['--reject-with','icmp-port-unreachable' if cmd=='iptables' else 'icmp6-port-unreachable']
        lines.append(' '.join(['-A',chain,*r]))
    print('\n'.join(lines))
    sys.exit(0)
elif op in ('-A','-I'):
    if chain not in chains: sys.exit(1)
    if op == '-I':
        assert rules[0] == '1'; rules = rules[1:]
        chains[chain].insert(0, rules)
    else: chains[chain].append(rules)
else: raise AssertionError('unexpected/deleting firewall command '+repr(args))
(p/'firewall.json').write_text(json.dumps(state))
'''

CONTROL = r'''#!/usr/bin/python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ['DNS_GUARD_FIXTURE'])
cmd = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
opts = json.loads((p/'firewall-options.json').read_text())
if cmd == 'cat' and args == ['/proc/sys/kernel/random/boot_id']:
    print(opts.get('boot_id','next-boot')); sys.exit(0)
if cmd == 'cut' and '/proc/uptime' in args:
    print(str(json.loads((p/'clock.json').read_text()))+'.00'); sys.exit(0)
if cmd == 'sleep':
    n=json.loads((p/'clock.json').read_text())
    (p/'clock.json').write_text(str(n+opts.get('sleep_step',2)))
    if opts.get('watch_repair'):
        if n == 0:
            state=json.loads((p/'firewall.json').read_text())
            state['iptables:nat']['OUTPUT']=[]
            (p/'firewall.json').write_text(json.dumps(state))
            (p/'removed-hook').write_text('yes')
        else: (p/'device'/'boot-ready-boot-id').write_text('next-boot\n')
    sys.exit(0)
os.execv('/usr/bin/'+cmd,[cmd,*args])
'''

# Model the important BusyBox property: applets resolve inside the explicitly
# selected executable, never through the child process's inherited PATH.
BUSYBOX = '''#!/bin/sh
applet=$1
shift
case "$applet" in
  cat|cut|sleep) exec "$DNS_GUARD_FIXTURE/bin/$applet" "$@" ;;
  sh) exec /bin/sh "$@" ;;
  *) exec "/usr/bin/$applet" "$@" ;;
esac
'''


def setup_firewall(p, options=None, controls=True):
    (p/'firewall.json').write_text('{}')
    (p/'firewall-events.jsonl').write_text('')
    (p/'firewall-options.json').write_text(json.dumps(options or {}))
    (p/'clock.json').write_text('0')
    mock=p/'bin'/'fw-fixture'; mock.write_text(FIREWALL); mock.chmod(0o700)
    for name in ('iptables', 'ip6tables'):
        path=p/'bin'/name
        if path.is_symlink() or path.exists(): path.unlink()
        path.symlink_to(mock)
    bb=p/'bin'/'busybox'
    if bb.is_symlink() or bb.exists(): bb.unlink()
    bb.write_text(BUSYBOX); bb.chmod(0o700)
    if controls:
        control=p/'bin'/'control'; control.write_text(CONTROL); control.chmod(0o700)
        for name in ('cat', 'cut', 'sleep'): (p/'bin'/name).symlink_to(control)
    shutil.copyfile(SOURCE/'video-dns-guard.sh', p/'device'/'video-dns-guard.sh')
    (p/'device'/'dns-guard-installed-boot-id').write_text('install-boot\n')


def fixture(root, name, options=None):
    p=root/name; (p/'bin').mkdir(parents=True); (p/'device').mkdir()
    setup_firewall(p, options)
    return p


def env(p):
    return {**os.environ, 'DNS_GUARD_FIXTURE':str(p),
            'PATH':str(p/'bin')+':/usr/bin:/bin',
            'VIDEO_PROXY_BUSYBOX':str(p/'bin'/'busybox'),
            'VIDEO_PROXY_IPTABLES':str(p/'bin'/'iptables'),
            'VIDEO_PROXY_IP6TABLES':str(p/'bin'/'ip6tables')}


def run(p, mode='--install', extra_env=None):
    return subprocess.run(['/bin/sh',str(p/'device'/'video-dns-guard.sh'),mode],
                          env={**env(p),**(extra_env or {})}, capture_output=True,text=True,timeout=20)


def state(p): return json.loads((p/'firewall.json').read_text())
def save(p, s): (p/'firewall.json').write_text(json.dumps(s))
def events(p): return [json.loads(x) for x in (p/'firewall-events.jsonl').read_text().splitlines()]
def mutations(p): return [e for e in events(p) if e[1][2] in ('-N','-I','-A','-F','-D')]


def packet(p, family, protocol, port=53, mark=0, skip_nat=False):
    """Evaluate the actual fixture rules, not a parallel desired rule list."""
    data=state(p); executable='iptables' if family==4 else 'ip6tables'
    current_port=port
    def chain(table, name):
        nonlocal current_port
        for rule in data.get(executable+':'+table,{}).get(name,[]):
            if '-p' in rule and rule[rule.index('-p')+1]!=protocol: continue
            if '--dport' in rule and int(rule[rule.index('--dport')+1])!=current_port: continue
            if '--mark' in rule and int(rule[rule.index('--mark')+1])!=mark: continue
            target=rule[rule.index('-j')+1]
            if target=='RETURN': return None
            if target in ('ACCEPT','REJECT'): return target
            if target=='REDIRECT':
                current_port=int(rule[rule.index('--to-ports')+1]); return 'REDIRECT'
            result=chain(table,target)
            if result is not None: return result
        return None
    if family==4 and not skip_nat: chain('nat','OUTPUT')
    result=chain('filter','OUTPUT')
    return 'REJECT' if result=='REJECT' else ('LOCAL_5354' if current_port==5354 else 'PASS')


def standalone(root):
    for label, options, missing in (
        ('same-boot',{'boot_id':'install-boot'},False),
        ('missing-boot',{'boot_id':''},False),
        ('missing-marker',{},True)):
        p=fixture(root,label,options)
        if missing: (p/'device'/'dns-guard-installed-boot-id').unlink()
        for mode in ('--install','--install-locked','--watch','--watch-locked'):
            result=run(p,mode)
            check(result.returncode==0 and 'deferred' in result.stdout,
                  label+' '+mode+' honors the next-boot barrier')
        check(not events(p),label+' executes zero firewall reads/writes')
    p=fixture(root,'healthy')
    check(run(p,'--verify').returncode!=0 and not mutations(p),'read-only verify rejects absent protection without mutations')
    check(run(p).returncode==0 and run(p,'--verify').returncode==0,'production shell installs and independently verifies all chains')
    for family in (4,6):
        for proto in ('udp','tcp'):
            expected='LOCAL_5354' if family==4 else 'REJECT'
            check(packet(p,family,proto)==expected,f'IPv{family} {proto} DNS cannot reach a cleartext external resolver')
            check(packet(p,family,proto,mark=255)=='PASS',f'IPv{family} {proto} mark 255 preserves the bootstrap bypass')
            check(packet(p,family,proto,port=443)=='PASS',f'IPv{family} {proto} non-DNS playback traffic is untouched')
    check(packet(p,4,'udp',skip_nat=True)=='REJECT' and packet(p,4,'tcp',skip_nat=True)=='REJECT',
          'IPv4 filter blocks stale conntrack packets that bypass NAT')
    check(packet(p,4,'udp',mark=786533)=='LOCAL_5354' and packet(p,6,'tcp',mark=786533)=='REJECT',
          'ordinary Android netd socket marks do not acquire the explicit 255 bypass')
    before=state(p); count=len(mutations(p))
    check(run(p).returncode==0 and state(p)==before and len(mutations(p))==count,'healthy repeated install performs zero firewall mutations')
    # A netd rebuild may remove output hooks while custom chains remain.
    s=state(p)
    for chains in s.values(): chains['OUTPUT']=[]
    save(p,s)
    check(run(p,'--verify').returncode!=0,'missing OUTPUT hooks are detected')
    check(run(p).returncode==0 and run(p,'--verify').returncode==0,'removed netd hooks are restored without flushing surviving chains')
    s=state(p)
    for chains in s.values(): chains['OUTPUT'].insert(0,['-j','ACCEPT'])
    save(p,s)
    check(packet(p,4,'udp')=='PASS' and run(p,'--verify').returncode!=0,'negative anchor: earlier ACCEPT defeats protection and verification rejects it')
    check(run(p).returncode==0 and packet(p,4,'udp')=='LOCAL_5354' and packet(p,6,'tcp')=='REJECT','repair puts guards before earlier ACCEPT rules')
    s=state(p)
    s['ip6tables:filter']['VIDEO_DNS6'].insert(0,['-j','RETURN'])
    s['iptables:filter']['VIDEO_DNS4_GUARD'].insert(0,['-j','ACCEPT'])
    save(p,s)
    check(run(p,'--verify').returncode!=0 and packet(p,6,'udp')=='PASS','negative anchor: broad custom-chain RETURN/ACCEPT cannot pass ordered verification')
    check(run(p).returncode==0 and packet(p,6,'udp')=='REJECT' and packet(p,4,'udp',skip_nat=True)=='REJECT','repair prepends complete guards before broad RETURN/ACCEPT without deleting live rules')
    s=state(p)
    rules=s['ip6tables:filter']['VIDEO_DNS6']; rules[0],rules[1]=rules[1],rules[0]
    save(p,s)
    check(packet(p,6,'udp',mark=255)=='REJECT' and run(p,'--verify').returncode!=0,'negative anchor: REJECT before mark bypass is rejected despite all rules existing')
    check(run(p).returncode==0 and packet(p,6,'udp',mark=255)=='PASS','ordered prefix repair restores bootstrap mark bypass')
    # Damage an existing rule and make its restoration fail: no protective hook
    # may be removed merely because the full rule set is temporarily unhealthy.
    s=state(p); s['iptables:nat']['VIDEO_DNS']=[]; save(p,s)
    (p/'firewall-options.json').write_text(json.dumps({'fail_table':'iptables:nat'}))
    check(run(p).returncode!=0,'NAT restoration failure is surfaced')
    check(packet(p,4,'udp')=='REJECT' and packet(p,6,'tcp')=='REJECT','NAT failure retains both family rejection guards')
    check(all(e[1][2] not in ('-F','-D','-X') for e in events(p)),'no success or failure path flushes or removes live protection')
    p=fixture(root,'nat-unavailable',{'fail_table':'iptables:nat'})
    check(run(p).returncode!=0 and packet(p,4,'udp')=='REJECT' and packet(p,6,'tcp')=='REJECT','fresh installation with unavailable NAT fails closed for both families')
    p=fixture(root,'watch-repair',{'watch_repair':True})
    check(run(p,'--watch').returncode==0 and (p/'removed-hook').exists(),'startup watcher really observes a fixture hook deletion before reaching ready')
    check(run(p,'--verify').returncode==0 and 'startup_audit_ready' in (p/'device'/'dns-guard.log').read_text(),'startup watcher repairs the hook and exits after final ready verification')
    p=fixture(root,'watch-limit',{'sleep_step':240})
    check(run(p,'--watch').returncode==1 and 'startup_audit_limit' in (p/'device'/'dns-guard.log').read_text(),'startup watcher has a monotonic 240-second limit')
    check(run(p,'--verify').returncode==0,'startup audit expiry leaves installed protection intact')
    p=fixture(root,'broken-path',{'watch_repair':True})
    broken={'PATH':str(p/'nonexistent-vendor-bin')}
    check(run(p,'--install',broken).returncode==0,'public install succeeds with an entirely missing PATH')
    check(run(p,'--watch',broken).returncode==0 and (p/'removed-hook').exists() and
          'startup_audit_ready' in (p/'device'/'dns-guard.log').read_text(),
          'public watch repairs a lost hook and actually reaches ready with an entirely missing PATH')
    p=fixture(root,'hostile-path',{'watch_repair':True})
    trap=p/'hostile'; trap.mkdir()
    touched=p/'path-command-used'
    for name in ('dirname','cat','cut','awk','sleep','sh','iptables','ip6tables','flock','timeout','nohup'):
        command=trap/name
        command.write_text('#!/bin/sh\nprintf "%s\\n" '+shlex.quote(name)+' >> '+shlex.quote(str(touched))+'\nexit 86\n')
        command.chmod(0o700)
    hostile={'PATH':str(trap)}
    negative=subprocess.run(['/bin/sh','-c','dirname "$1"','sh','/data/adb/video-proxy/test.sh'],
                            env={**env(p),**hostile},capture_output=True,text=True,timeout=5)
    check(negative.returncode==86 and touched.read_text().strip()=='dirname',
          'negative anchor: hostile PATH really intercepts the original unqualified dirname dependency')
    touched.unlink()
    check(run(p,'--install',hostile).returncode==0 and run(p,'--watch',hostile).returncode==0 and
          'startup_audit_ready' in (p/'device'/'dns-guard.log').read_text(),
          'public install and watch reach actual ready with every PATH dependency poisoned')
    check(not touched.exists(),'guard and its recursively spawned shells never execute a poisoned PATH command')


def boot_flow():
    # Reuse the existing boot fixtures for time/proxy/resolver behavior, but run
    # the current production worker and our stateful firewall, not old logic.
    file=SOURCE.parent/'video-proxy-boot'/'test_boot_flow.py'
    spec=importlib.util.spec_from_file_location('boot_fixture',file)
    mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    suite=mod.Suite(file.parent)
    try:
        def make(name,**options):
            p=suite.fixture(name,**options)
            mock=p/'bin'/'mock_dispatch'
            mock.write_text(mock.read_text().replace(
                "emit('proxy.config.check'); sys.exit(0)",
                "emit('proxy.config.check'); sys.exit(1 if opts.get('config_fail') else 0)"))
            shutil.copyfile(SOURCE/'video-boot-start.next.sh',p/'device'/'video-boot-start.sh')
            setup_firewall(p,controls=False)
            # Retain the existing events-aware clock helper; add timeout support
            # to the existing busybox dispatcher instead of touching production.
            # The current worker scans real /proc for precise main identity.
            # Avoid starting Python once per unrelated host process; only the
            # fixture-owned sleep needs the existing mock identity behavior.
            (p/'bin'/'slow').mkdir()
            (p/'bin'/'slow'/'readlink').symlink_to(p/'bin'/'mock_dispatch')
            readlink=p/'bin'/'readlink'; readlink.unlink()
            readlink.write_text('''#!/bin/sh
if [ -f "$BOOT_TEST_FIXTURE/owned.pid" ]; then
  read -r owned < "$BOOT_TEST_FIXTURE/owned.pid"
  if [ "$1" = "/proc/$owned/exe" ]; then
    exec "$BOOT_TEST_FIXTURE/bin/slow/readlink" "$@"
  fi
fi
exec /usr/bin/readlink "$@"
''')
            readlink.chmod(0o700)
            return p
        old_env=suite.env
        suite.env=lambda p:{**old_env(p),'DNS_GUARD_FIXTURE':str(p),
                            'VIDEO_PROXY_IPTABLES':str(p/'bin'/'iptables'),
                            'VIDEO_PROXY_IP6TABLES':str(p/'bin'/'ip6tables')}
        p=make('production-success')
        result=suite.run(p)
        check(result.returncode==0,'current production boot worker reaches success with the real guard shell')
        check((p/'device'/'boot-ready-boot-id').read_text().strip()=='next-boot' and run(p,'--verify').returncode==0,'boot readiness requires all actual protection hooks')
        check('dns_caches_flushed' in suite.log(p) and suite.actions(p).count('proxy.run')==1,'successful guard integration retains resolver flush and exactly one proxy')
        p=make('dns-failure',dns_fail=True,hold_retry=True)
        suite.until_retry(p)
        check('dns_failed_no_takeover' in suite.log(p) and not suite.alive(p),'failed upstream DNS stops only the fixture-owned proxy and enters retry')
        check(run(p,'--verify').returncode==0 and packet(p,4,'udp',skip_nat=True)=='REJECT','upstream DNS failure retains early protection through retry')
        p=make('ntp-failure',ntp_fail=True,hold_retry=True)
        suite.until_retry(p)
        check('proxy.run' not in suite.actions(p) and 'time_sources_unavailable' in suite.log(p),'NTP outage does not start a proxy with a wrong clock')
        check(run(p,'--verify').returncode==0 and packet(p,4,'udp',mark=255)=='PASS','NTP outage retains DNS protection and the explicit bootstrap recovery path')
        for name, marker, rollback_rc in (
            ('rollback-success','next-boot',0),
            ('rollback-old-boot','old-boot',0),
            ('rollback-failure','next-boot',1)):
            p=make(name,config_fail=True)
            d=p/'device'; upgrade=d/'dns-upgrade-20261024'; upgrade.mkdir()
            (upgrade/'applied-boot-id').write_text(marker+'\n')
            restored='#!/bin/sh\nprintf "%s\\n" "$*" > '+shlex.quote(str(p/'restored-worker-called'))+'\n'
            callback='#!/bin/sh\n[ "$1" = --rollback ] || exit 2\nprintf called > '+shlex.quote(str(p/'rollback-called'))+'\n'
            if rollback_rc:
                callback+='exit 1\n'
            else:
                callback+='printf %s '+shlex.quote(restored)+' > '+shlex.quote(str(d/'video-boot-start.sh'))+'\n'
            (upgrade/'dns-upgrade-apply.sh').write_text(callback)
            result=suite.run(p)
            if name=='rollback-success':
                check(result.returncode==0 and (p/'rollback-called').exists() and (p/'restored-worker-called').read_text().strip()=='--locked','same-boot config failure invokes rollback then executes the restored worker with its lock')
            elif name=='rollback-old-boot':
                check(result.returncode==1 and not (p/'rollback-called').exists(),'config failure never invokes another boot transaction rollback')
            else:
                check(result.returncode==1 and (p/'rollback-called').exists() and not (p/'restored-worker-called').exists(),'failed transaction rollback stops before executing any replacement worker')
            check('proxy.run' not in suite.actions(p),name+' never starts a proxy with invalid configuration')
    finally:
        suite.clean()


if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='dns-guard-tests-') as tmp:
        standalone(Path(tmp))
    boot_flow()
    print(f'PASS all {COUNT} DNS guard and current boot integration assertions',flush=True)
