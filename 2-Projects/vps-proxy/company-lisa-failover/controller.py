#!/usr/bin/env python3
"""Priority failover through Xray RoutingService; no credentials required."""
import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import random
import re
import subprocess
import tempfile
import time

NAMES = ('dmit', 'zgo', 'home')


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(value, f, sort_keys=True)
            f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


class Policy:
    def __init__(self, selected='block', recovery=120, hold=300):
        self.selected, self.recovery, self.hold = selected, recovery, hold
        self.since = None
        self.last = None
        self.health = {n: {'ok_since': None, 'failures': 0, 'ok': False} for n in NAMES}

    def decide(self, results, now, pin=None):
        if self.last is not None and (now-self.last > 45 or now < self.last):
            for h in self.health.values(): h.update(ok_since=None, failures=0, ok=False)
            if now < self.last: self.since = now
        self.last = now
        if self.since is None: self.since = now
        for name in NAMES:
            h = self.health[name]; h['ok'] = bool(results[name])
            if results[name]:
                h['failures'] = 0
                if h['ok_since'] is None: h['ok_since'] = now
            else:
                h['failures'] += 1; h['ok_since'] = None
        if pin:
            return pin if pin in NAMES and results[pin] else 'block'
        current = self.selected
        # Current path tolerates one failed round. Candidates need fresh evidence.
        if current in NAMES and self.health[current]['failures'] < 2:
            if now-self.since >= self.hold:
                for n in NAMES[:NAMES.index(current)]:
                    h = self.health[n]
                    if h['ok_since'] is not None and now-h['ok_since'] >= self.recovery:
                        return n
            return current
        return next((n for n in NAMES if results[n]), 'block')

    def applied(self, choice, now):
        if self.selected != choice:
            self.selected = choice; self.since = now


def probe(curl, port, target):
    cmd = [curl, '-q', '--proxy', 'socks5h://127.0.0.1:'+str(port), '--noproxy', '',
           '--silent', '--output', '/dev/null', '--write-out', '%{http_code}',
           '--connect-timeout', '4', '--max-time', '6', target['url']]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        code = r.stdout.strip()
        ok = r.returncode == 0 and code in target['accept']
        return {'ok': ok, 'http': code if re.fullmatch(r'\d{3}', code) else '000',
                'exit': r.returncode,
                'kind': 'ok' if ok else ('target_rejected' if r.returncode == 0 else 'transport')}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'http': '000', 'exit': -1, 'kind': 'timeout'}


def probe_all(cfg):
    if len(cfg.get('targets',[])) != 2:
        raise ValueError('exactly_two_independent_targets_required')
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        pending = {(n,t['name']): pool.submit(probe,cfg['curl'],cfg['ports'][n],t)
                   for n in NAMES for t in cfg['targets']}
        detail = {n: {} for n in NAMES}
        for (n,t), future in pending.items(): detail[n][t] = future.result()
    return {n: all(x['ok'] for x in detail[n].values()) for n in NAMES}, detail


def api(cfg, command, *args):
    r = subprocess.run([cfg['xray'], 'api', command, '--server='+cfg['api'], *args],
                       capture_output=True, text=True, timeout=5)
    if r.returncode: raise RuntimeError('routing_api_'+command+'_failed')
    return r.stdout


def read_override(cfg):
    output = api(cfg, 'bi', cfg['balancer'])
    match = re.search(r'Selecting Override:\s*\n\s*1[ \t]*([^\r\n]*)', output)
    if not match: raise RuntimeError('unknown_bi_format')
    tag = match.group(1).strip()
    if not tag: return 'block'  # config default selector is ONLY cf-block
    reverse = {v:k for k,v in cfg['tags'].items()}
    if tag not in reverse: raise RuntimeError('foreign_override_stop')
    return reverse[tag]


def set_choice(cfg, choice):
    api(cfg, 'bo', '-b', cfg['balancer'], cfg['tags'][choice])
    if read_override(cfg) != choice: raise RuntimeError('routing_override_readback_failed')


def read_pin(path):
    try:
        pin = json.loads(Path(path).read_text())
        return pin['route'] if pin['expires'] > time.time() and pin['route'] != 'auto' else None
    except FileNotFoundError: return None


def run(cfg):
    state = Path(cfg['state']); state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with state.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        logger = logging.getLogger('failover'); logger.setLevel(logging.INFO)
        handler = RotatingFileHandler(str(state.with_suffix('.log')), maxBytes=1048576, backupCount=3)
        handler.setFormatter(logging.Formatter('%(asctime)s %(message)s')); logger.addHandler(handler)
        policy = Policy(); last_summary = 0; previous_status = None
        started_at = time.time(); rounds = 0; switches = 0
        totals = {n: {'pass':0,'fail':0} for n in NAMES}
        while True:
            start = time.monotonic()
            try:
                if cfg.get('guard_config_path'):
                    current_hash = hashlib.sha256(Path(cfg['guard_config_path']).read_bytes()).hexdigest()
                    if current_hash != cfg['guard_config_sha256']: raise RuntimeError('production_config_drift_stop')
                actual = read_override(cfg)
                policy.applied(actual, start)
                results, detail = probe_all(cfg)
                rounds += 1
                for n in NAMES: totals[n]['pass' if results[n] else 'fail'] += 1
                now = time.monotonic(); pin = read_pin(cfg['pin'])
                choice = policy.decide(results, now, pin)
                changed = choice != actual
                if changed:
                    set_choice(cfg, choice); policy.applied(choice, now); switches += 1
                    logger.warning('SWITCH %s -> %s pin=%s', actual, choice, pin)
                status = 'ALL_DOWN' if not any(results.values()) else ('PIN_UNAVAILABLE' if pin and choice=='block' else 'OK')
                output = {'version':1,'updated_at':time.time(),'selected':choice,'status':status,
                          'health':policy.health,'probes':detail,'pin':pin,'process_started_at':started_at,
                          'rounds':rounds,'probe_totals':totals,'switches':switches}
                atomic_json(state,output)
                if changed or status != previous_status or now-last_summary >= 300:
                    logger.warning('HEALTH selected=%s status=%s results=%s totals=%s switches=%s',choice,status,results,totals,switches)
                    last_summary = now; previous_status = status
            except Exception as exc:
                # Never leak subprocess output/config/credentials into logs.
                logger.error('CONTROLLER_ERROR %s', type(exc).__name__)
                atomic_json(state, {'version':1,'updated_at':time.time(),'status':'CONTROL_ERROR',
                                    'selected':policy.selected,'error_type':type(exc).__name__})
            time.sleep(max(0.2, 15 + random.uniform(-1,1) - (time.monotonic()-start)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--status',action='store_true')
    parser.add_argument('--pin',choices=(*NAMES,'block','auto'))
    parser.add_argument('--duration',type=int,default=900)
    args=parser.parse_args(); cfg=json.loads(Path(args.config).read_text())
    os.umask(0o077)
    if args.status:
        result=json.loads(Path(cfg['state']).read_text())
        result['stale']=time.time()-result['updated_at']>45
        print(json.dumps(result,ensure_ascii=False,indent=2)); return
    if args.pin:
        if not 1<=args.duration<=86400: parser.error('duration must be 1..86400 seconds')
        atomic_json(cfg['pin'],{'route':args.pin,'expires':time.time()+args.duration}); return
    run(cfg)

if __name__=='__main__': main()
