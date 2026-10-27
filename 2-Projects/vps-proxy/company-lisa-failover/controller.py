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

ERROR_CODES = frozenset({
    'production_config_drift_stop', 'production_config_parse_failed',
    'foreign_override_stop', 'unknown_bi_format', 'routing_override_readback_failed',
    'routing_api_bi_failed', 'routing_api_bo_failed',
    'routing_api_bi_timeout', 'routing_api_bo_timeout',
})
RETRYABLE_API_ERRORS = frozenset({
    'routing_api_bi_failed', 'routing_api_bo_failed',
    'routing_api_bi_timeout', 'routing_api_bo_timeout',
})


def safe_error_code(exc):
    code = exc.args[0] if isinstance(exc, RuntimeError) and len(exc.args) == 1 else None
    return code if isinstance(code, str) and code in ERROR_CODES else 'unexpected_error'


def canonical_config_sha256(raw):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_json_key')
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=unique_object)
        data = json.dumps(value, sort_keys=True, separators=(',', ':'),
                          ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, TypeError):
        raise RuntimeError('production_config_parse_failed') from None
    return hashlib.sha256(data).hexdigest()


def check_config_guard(cfg):
    if not cfg.get('guard_config_path'):
        return 'disabled'
    raw = Path(cfg['guard_config_path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() == cfg['guard_config_sha256']:
        return 'byte'
    expected = cfg.get('guard_config_semantic_sha256')
    if expected and canonical_config_sha256(raw) == expected:
        return 'semantic'
    raise RuntimeError('production_config_drift_stop')



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
        self.all_down_rounds = 0
        self.health = {n: {'ok_since': None, 'failures': 0, 'ok': False} for n in NAMES}

    def decide(self, results, now, pin=None, reachable=None):
        reachable = results if reachable is None else reachable
        if self.last is not None and (now-self.last > 45 or now < self.last):
            for h in self.health.values(): h.update(ok_since=None, failures=0, ok=False)
            self.all_down_rounds = 0
            if now < self.last: self.since = now
        self.last = now
        self.all_down_rounds = 0 if any(reachable.values()) else self.all_down_rounds + 1
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
        healthy = next((n for n in NAMES if results[n]), None)
        if healthy:
            return healthy
        # A shared target timeout is not evidence that all permitted paths are dead.
        if current in NAMES and reachable[current]:
            return current
        partial = next((n for n in NAMES if reachable[n]), None)
        if partial:
            return partial
        # Never invent a route at cold start; retain only a previously selected one.
        if current in NAMES and self.all_down_rounds < 3:
            return current
        return 'block'

    def applied(self, choice, now):
        if self.selected != choice:
            self.selected = choice; self.since = now


def probe(curl, port, target):
    cmd = [curl, '-q', '--proxy', 'socks5h://127.0.0.1:'+str(port), '--noproxy', '',
           '--silent', '--output', '/dev/null', '--write-out', '%{http_code}',
           '--connect-timeout', '8', '--max-time', '12', target['url']]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=14)
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
    service = {n: all(x['ok'] for x in detail[n].values()) for n in NAMES}
    reachable = {n: any(x['ok'] for x in detail[n].values()) for n in NAMES}
    return service, reachable, detail


def api(cfg, command, *args):
    try:
        r = subprocess.run([cfg['xray'], 'api', command, '--server='+cfg['api'], *args],
                           capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        raise RuntimeError('routing_api_'+command+'_timeout') from None
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
        api_error_streak = 0; last_good_at = None; last_good_route = None
        totals = {n: {'pass':0,'fail':0} for n in NAMES}
        while True:
            start = time.monotonic(); fast_retry = False
            try:
                guard_match = check_config_guard(cfg)
                actual = read_override(cfg)
                policy.applied(actual, start)
                results, reachable, detail = probe_all(cfg)
                rounds += 1
                for n in NAMES: totals[n]['pass' if results[n] else 'fail'] += 1
                now = time.monotonic(); pin = read_pin(cfg['pin'])
                # Probes may outlive an Xray restart or a config edit. Reconcile fresh state.
                guard_match = check_config_guard(cfg)
                actual = read_override(cfg)
                policy.applied(actual, now)
                choice = policy.decide(results, now, pin, reachable=reachable)
                changed = choice != actual
                if changed:
                    set_choice(cfg, choice); policy.applied(choice, now); switches += 1
                    logger.warning('SWITCH %s -> %s pin=%s', actual, choice, pin)
                status = ('ALL_DOWN' if not any(reachable.values()) else
                          'PIN_UNAVAILABLE' if pin and choice == 'block' else
                          'OK' if results.get(choice, False) else 'DEGRADED')
                if results.get(choice, False):
                    last_good_at = time.time(); last_good_route = choice
                output = {'version':1,'updated_at':time.time(),'selected':choice,'status':status,
                          'guard_match':guard_match,'last_good_at':last_good_at,'last_good_route':last_good_route,
                          'health':policy.health,'reachable':reachable,'all_down_rounds':policy.all_down_rounds,
                          'probes':detail,'pin':pin,'process_started_at':started_at,
                          'rounds':rounds,'probe_totals':totals,'switches':switches}
                atomic_json(state,output)
                if changed or status != previous_status or now-last_summary >= 300:
                    logger.warning('HEALTH selected=%s status=%s service=%s reachable=%s all_down_rounds=%s probes=%s totals=%s switches=%s',
                                   choice,status,results,reachable,policy.all_down_rounds,detail,totals,switches)
                    last_summary = now; previous_status = status
                api_error_streak = 0
            except Exception as exc:
                # Never leak subprocess output/config/credentials into logs.
                code = safe_error_code(exc)
                api_error_streak = api_error_streak + 1 if code in RETRYABLE_API_ERRORS else 0
                fast_retry = 0 < api_error_streak <= 3
                logger.error('CONTROLLER_ERROR code=%s type=%s', code, type(exc).__name__)
                atomic_json(state, {'version':1,'updated_at':time.time(),'status':'CONTROL_ERROR',
                                    'selected':policy.selected,'error_type':type(exc).__name__,'error_code':code,
                                    'last_good_at':last_good_at,'last_good_route':last_good_route})
            time.sleep(2 if fast_retry else max(0.2, 15 + random.uniform(-1,1) - (time.monotonic()-start)))


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
