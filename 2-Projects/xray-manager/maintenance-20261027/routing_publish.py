"""Coordinated, journalled Air routing publication; never a generic config writer.

Only routing_policy plans can enter this publisher. Main Xray is deliberately
restarted: this changes persistent routing and interrupts existing connections.
No shell, global process killing, hot whole-table replacement, or pending clear.
"""
import contextlib
import copy
import fcntl
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import plistlib
import re
import secrets
import subprocess
import tempfile
import time

try:
    import routing_policy as policy
except ImportError:
    policy = None

PREVIEW_TTL = 300
MAX_JSON = 4 * 1024 * 1024
TAGS = {n: 'cf-' + n for n in ('dmit', 'zgo', 'home', 'block')}
TERMINAL = frozenset(('applied', 'rolled_back'))
SAFE_FALLBACK_PROTOCOLS = frozenset(('vless', 'vmess', 'socks', 'http', 'shadowsocks',
                                    'trojan', 'wireguard', 'blackhole'))
IDENTITY_DEPENDENCIES = frozenset(('binary', 'controller_code', 'controller_plist', 'main_plist', 'grok_plist'))
FOREIGN_OVERRIDE_ERRORS = frozenset(('override_unknown', 'override_changed', 'override_readback'))


class PublisherError(Exception):
    def __init__(self, code, message, status_code=409):
        self.code, self.message, self.status_code = code, message, status_code
        super().__init__(message)


def _fail(code, message, status=409):
    raise PublisherError(code, message, status)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def _json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_key')
            result[key] = value
        return result

    def invalid(value):
        raise ValueError('invalid_number')

    try:
        if len(raw) > MAX_JSON:
            raise ValueError('too_large')
        result = json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)
        if not isinstance(result, dict):
            raise ValueError('not_object')
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError):
        _fail('invalid_json', '配置或发布记录不是有效的 JSON 对象', 422)


def _encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def _semantic(value):
    return _sha(json.dumps(value, ensure_ascii=False, sort_keys=True,
                           separators=(',', ':'), allow_nan=False).encode())


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


class RoutingPublisher:
    def __init__(self, xray_home, *, runner=None, clock=None, sleeper=None):
        self.home = Path(xray_home).expanduser().absolute()
        self.runtime = self.home / 'company-lisa-failover'
        self.root = self.home / '.routing-publish'
        self.targets = {'config': self.home / 'config.json',
                        'controller': self.runtime / 'controller.json',
                        'metadata': self.home / 'routing-policy.json'}
        self.bin = self.home / 'xray'
        self.plist_dir = self.home.parent / 'Library/LaunchAgents'
        self.controller_plist = self.plist_dir / 'com.company.lisa-failover.plist'
        self.main_plist = self.plist_dir / 'com.xray.proxy.plist'
        self.domain = 'gui/' + str(os.getuid())
        self.controller_label = self.domain + '/com.company.lisa-failover'
        self.main_label = self.domain + '/com.xray.proxy'
        self.grok_label = self.domain + '/com.mycc.grok-bot.proxy'
        self.runner, self.clock, self.sleep = runner or subprocess.run, clock or time.time, sleeper or time.sleep

    def _policy(self):
        global policy
        if policy is None:
            try:
                policy = importlib.import_module('routing_policy')
            except ImportError:
                _fail('policy_unavailable', '路由策略模块不可用', 503)
        return policy

    def _raw(self, path, optional=False, limit=MAX_JSON):
        try:
            if path.is_symlink():
                _fail('unsafe_path', '发布文件不能是符号链接')
            with path.open('rb') as stream:
                raw = stream.read(limit + 1)
            if len(raw) > limit:
                _fail('file_too_large', '发布文件超出大小限制', 422)
            return raw
        except FileNotFoundError:
            if optional:
                return None
            _fail('file_missing', '所需配置或运行文件缺失', 503)
        except OSError:
            _fail('file_unreadable', '无法读取所需配置或运行文件', 503)

    def _snapshot(self, validate=True):
        raw = {name: self._raw(path, name == 'metadata') for name, path in self.targets.items()}
        cfg, ctl = _json(raw['config']), _json(raw['controller'])
        meta = _json(raw['metadata']) if raw['metadata'] is not None else {'version': 1, 'disabled': {}}
        hashes = {name: _sha(value) for name, value in raw.items()}
        result = {'raw': raw, 'hashes': hashes, 'revision': _semantic(hashes),
                  'config': cfg, 'controller': ctl, 'metadata': meta,
                  'modes': {n: (p.stat().st_mode & 0o777) if raw[n] is not None else 0o600
                            for n, p in self.targets.items()}}
        if validate:
            self._validate_controller(result)
        return result

    def _validate_controller(self, snapshot):
        c, core = snapshot['controller'], snapshot['config']
        expected = {'xray': str(self.bin), 'balancer': 'cf-lisa', 'tags': TAGS,
                    'state': str(self.runtime / 'state.json'), 'pin': str(self.runtime / 'pin.json'),
                    'guard_config_path': str(self.targets['config'])}
        if any(c.get(key) != value for key, value in expected.items()):
            _fail('controller_contract', '受管控制器路径或保护范围不符合发布约束', 422)
        address = c.get('api', '')
        if not isinstance(address, str) or not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}', address):
            _fail('controller_api', '控制器 API 必须是已配置的本机回环地址', 422)
        if not 1 <= int(address.rsplit(':', 1)[1]) <= 65535:
            _fail('controller_api', '控制器 API 端口无效', 422)
        api = core.get('api', {})
        if (not isinstance(api, dict) or api.get('listen') != address
                or 'RoutingService' not in api.get('services', [])):
            _fail('controller_api', '主配置与控制器 API 不一致', 422)
        if (c.get('guard_config_sha256') != snapshot['hashes']['config']
                and c.get('guard_config_semantic_sha256') != _semantic(core)):
            _fail('guard_drift', '现役配置与控制器保护摘要不一致')

    def _dependencies(self):
        paths = {'pin': self.runtime / 'pin.json', 'binary': self.bin,
                 'controller_code': self.runtime / 'controller.py',
                 'controller_plist': self.controller_plist, 'main_plist': self.main_plist,
                 'grok_plist': self.plist_dir / 'com.mycc.grok-bot.proxy.plist',
                 'geoip': self.home / 'geoip.dat', 'geosite': self.home / 'geosite.dat'}
        hashes = {}
        for name, path in paths.items():
            raw = self._raw(path, name in ('pin', 'geoip', 'geosite', 'grok_plist'), limit=160 * 1024 * 1024)
            hashes[name] = _sha(raw)
        for path, label, expected in (
                (self.main_plist, 'com.xray.proxy', [str(self.bin), 'run', '-c', str(self.targets['config'])]),
                (self.controller_plist, 'com.company.lisa-failover',
                 ['/usr/bin/python3', '-B', str(self.runtime / 'controller.py'), '--config', str(self.targets['controller'])])):
            try:
                data = plistlib.loads(self._raw(path))
            except Exception:
                _fail('invalid_launchagent', 'LaunchAgent 内容无法验证', 422)
            if data.get('Label') != label or data.get('ProgramArguments') != expected:
                _fail('invalid_launchagent', 'LaunchAgent 的目标进程与已验证路径不一致', 422)
            if data.get('Program', expected[0]) != expected[0]:
                _fail('invalid_launchagent', 'LaunchAgent 的可执行程序不一致', 422)
            working = self.runtime if label == 'com.company.lisa-failover' else self.home
            if data.get('WorkingDirectory', str(working)) != str(working):
                _fail('invalid_launchagent', 'LaunchAgent 的工作目录不一致', 422)
        if hashes['grok_plist'] is not None:
            try:
                data = plistlib.loads(self._raw(paths['grok_plist']))
                args = [str(self.bin), 'run', '-c', str(self.home / 'grok-bot-proxy.json')]
                if (data.get('Label') != 'com.mycc.grok-bot.proxy' or data.get('ProgramArguments') != args
                        or data.get('Program', args[0]) != args[0]):
                    raise ValueError('grok_identity')
            except Exception:
                _fail('invalid_grok_launchagent', '独立 Grok 代理身份无法确认', 422)
        return hashes

    def _pin(self):
        raw = self._raw(self.runtime / 'pin.json', True)
        if raw is None:
            return {'sha256': None, 'active': None}
        value = _json(raw)
        if value.get('route') not in (*TAGS, 'auto') or not _number(value.get('expires')):
            _fail('pin_invalid', '手动路由状态无法确认', 503)
        active = (value['route'], value['expires']) if value['route'] != 'auto' and value['expires'] > self.clock() else None
        return {'sha256': _sha(raw), 'active': list(active) if active else None}

    def _same_pin(self, expected):
        if self._pin() != expected:
            _fail('pin_changed', '手动路由或有效期已改变，停止恢复旧出口')

    def _run(self, argv, code='command_failed', timeout=5):
        try:
            result = self.runner(argv, capture_output=True, text=True, timeout=timeout,
                                 cwd=str(self.home), env=dict(os.environ, XRAY_LOCATION_ASSET=str(self.home)))
        except Exception:
            _fail(code, '发布所需命令未完成；详细输出未公开', 503)
        if result.returncode:
            _fail(code, '发布所需命令失败；详细输出未公开', 503)
        return result.stdout if isinstance(result.stdout, str) else ''

    def _process(self, label):
        try:
            result = self.runner(['/bin/launchctl', 'print', label], capture_output=True, text=True, timeout=3)
        except Exception:
            _fail('service_unknown', '无法确认精确 LaunchAgent 状态', 503)
        if result.returncode == 113:
            return None
        output = result.stdout if isinstance(result.stdout, str) else ''
        pids = re.findall(r'(?m)^\s*pid = ([1-9][0-9]*)\s*$', output)
        if result.returncode or len(pids) != 1 or not re.search(r'(?m)^\s*state = running\s*$', output):
            _fail('service_unknown', '精确 LaunchAgent 未处于可确认的运行状态', 503)
        return int(pids[0])

    def _override(self, controller, allow_empty=False):
        text = self._run([str(self.bin), 'api', 'bi', '--server=' + controller['api'], 'cf-lisa'], 'override_unavailable')
        lines = text.replace('\r\n', '\n').split('\n')
        heads = [i for i, line in enumerate(lines) if 'Selecting Override:' in line]
        if (len(heads) != 1 or not re.fullmatch(r'[ \t]*(?:-[ \t]+)?Selecting Override:[ \t]*', lines[heads[0]])
                or heads[0] + 1 >= len(lines)):
            _fail('override_unknown', '实际路由覆盖格式无法确认', 503)
        row = re.fullmatch(r'[ \t]*1(?:[ \t]+([^\r\n]*))?', lines[heads[0] + 1])
        following = next((s for s in lines[heads[0] + 2:] if s.strip()), None)
        if (row is None or (following is not None and not re.fullmatch(
                r'[ \t]*(?:-[ \t]+)?[A-Za-z][A-Za-z ]*:[ \t]*', following))):
            _fail('override_unknown', '实际路由覆盖格式存在歧义', 503)
        tag = (row.group(1) or '').strip()
        if tag not in TAGS.values() and not (allow_empty and not tag):
            _fail('override_unknown', '实际路由覆盖为空或由其它控制者设置', 503)
        return tag

    def _observe(self, controller, min_updated=None, expected_override=None):
        main_pid, controller_pid = self._process(self.main_label), self._process(self.controller_label)
        if main_pid is None or controller_pid is None:
            _fail('service_stopped', '主代理或受管控制器未运行', 503)
        override = self._override(controller)
        state = _json(self._raw(self.runtime / 'state.json'))
        now, updated = self.clock(), state.get('updated_at')
        route = next(n for n, tag in TAGS.items() if tag == override)
        if (not _number(updated) or not 0 <= now - updated <= 45
                or (min_updated is not None and updated < min_updated)
                or state.get('status') != 'OK' or state.get('selected') != route
                or state.get('guard_match') not in ('byte', 'semantic')
                or (expected_override is not None and override != expected_override)):
            _fail('health_unverified', '控制器状态过期、出口不一致或健康尚未确认', 503)
        detail = state.get('probes', {}).get(route, {})
        for name, accepted in (('https', ('204',)), ('codex', ('200', '401'))):
            probe = detail.get(name, {})
            if probe.get('ok') is not True or probe.get('exit') != 0 or probe.get('http') not in accepted:
                _fail('probes_unverified', '当前出口的业务探针尚未通过', 503)
        return {'main_pid': main_pid, 'controller_pid': controller_pid, 'grok_pid': self._process(self.grok_label),
                'override': override, 'verified_at': now}

    def _mkdir(self, path):
        if path.exists():
            if path.is_symlink() or not path.is_dir() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
                _fail('unsafe_state_directory', '发布记录目录权限或归属不安全')
        else:
            path.mkdir(mode=0o700)

    def _ensure_root(self):
        self._mkdir(self.root)
        self._mkdir(self.root / 'previews')

    def _atomic(self, path, raw, mode=0o600):
        if path.is_symlink():
            _fail('unsafe_path', '拒绝替换符号链接目标')
        fd, name = tempfile.mkstemp(prefix='.routing-', dir=str(path.parent))
        try:
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), mode)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, path)
            directory = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    @contextlib.contextmanager
    def _lock(self):
        self._ensure_root()
        fd = os.open(str(self.root / 'publish.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                _fail('publication_busy', '另一项路由发布正在进行', 423)
            yield
        finally:
            os.close(fd)

    def _stage(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32}', token):
            _fail('invalid_preview', '预览标识无效', 422)
        return self.root / 'previews' / token

    def _verify_stage(self, stage):
        for path in (stage, stage / 'before', stage / 'candidate'):
            if (path.is_symlink() or not path.is_dir() or path.stat().st_uid != os.getuid()
                    or path.stat().st_mode & 0o077):
                _fail('unsafe_preview', '预览目录权限或归属无法确认')

    def _active(self):
        raw = self._raw(self.root / 'active.json', True)
        if raw is None:
            return None
        pointer = _json(raw)
        stage = self._stage(pointer.get('preview_id'))
        self._verify_stage(stage)
        return _json(self._raw(stage / 'journal.json'))

    def _assert_no_pending(self):
        active = self._active()
        if active and (not active.get('complete') or active.get('state') not in TERMINAL):
            _fail('recovery_required', '存在未完成发布；请先按 .routing-publish/active.json 回执恢复', 409)

    def _journal(self, stage, journal):
        journal['updated_at'] = self.clock()
        self._atomic(stage / 'journal.json', _encode(journal))

    def _candidate(self, snapshot, request):
        p = self._policy()
        try:
            planned = p.plan_change(copy.deepcopy(snapshot['config']), copy.deepcopy(snapshot['metadata']), copy.deepcopy(request))
        except p.PolicyError as exc:
            raise PublisherError(exc.code, exc.message, 422) from None
        core = planned['config']
        before, after = copy.deepcopy(snapshot['config']), copy.deepcopy(core)
        old_rules = before.get('routing', {}).pop('rules', None)
        new_rules = after.get('routing', {}).pop('rules', None)
        if before != after or not isinstance(new_rules, list) or not isinstance(old_rules, list):
            _fail('scope_changed', '本发布器仅允许策略生成的路由规则变化', 422)
        def protected(rules):
            return [(index, r) for index, r in enumerate(rules) if any(isinstance(x, str) and (x.startswith('cf-probe-') or x == 'cf-api')
                                          for x in r.get('inboundTag', [])) or r.get('outboundTag') == 'cf-api']
        if protected(old_rules) != protected(new_rules):
            _fail('protected_changed', 'API 或探针路由不可改变', 422)
        data = _encode(core)
        controller = copy.deepcopy(snapshot['controller'])
        controller.update(guard_config_sha256=_sha(data), guard_config_semantic_sha256=_semantic(core))
        return planned, {'config': data, 'controller': _encode(controller), 'metadata': _encode(planned['metadata'])}

    def _test(self, path):
        self._run([str(self.bin), 'run', '-test', '-c', str(path)], 'config_test_failed', timeout=15)

    def status(self):
        publication = {'state': 'unverified', 'verified_at': None}
        active = None
        active_checked = False
        try:
            active = self._active()
            active_checked = True
            if active and (not active.get('complete') or active.get('state') not in TERMINAL):
                publication = {'state': 'recovery_required', 'verified_at': None,
                               'message': '发布未完成，请先按 .routing-publish/active.json 回执恢复'}
                lockfile = self.root / 'publish.lock'
                if lockfile.exists() and not lockfile.is_symlink():
                    with lockfile.open('rb') as stream:
                        try:
                            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except BlockingIOError:
                            publication['state'] = 'applying'
            s = self._snapshot()
            p = self._policy()
            audit = p.audit_config(s['config'], s['metadata'])
            groups = p.group_states(s['config'], s['metadata'])
            if active and active.get('complete') and active.get('state') in TERMINAL and active.get('revision') == s['revision']:
                observed = self._observe(s['controller'])
                current_dependencies = self._dependencies()
                recorded = active.get('dependencies', {})
                identities_match = all(current_dependencies[name] == recorded.get(name) for name in IDENTITY_DEPENDENCIES)
                if observed['main_pid'] == active.get('main_pid') and identities_match:
                    assets_changed = any(current_dependencies[name] != recorded.get(name) for name in ('geoip', 'geosite'))
                    publication = {'state': active['state'], 'verified_at': active.get('verified_at'),
                                   'observed_at': observed['verified_at'], 'disk_assets_changed': assets_changed}
                    if assets_changed:
                        publication['message'] = '发布后磁盘资源已变化；不表示当前进程已加载，请按待生效资源记录维护'
            fallbacks = [{'tag': o['tag'], 'protocol': o.get('protocol', '')}
                         for o in s['config'].get('outbounds', []) if isinstance(o.get('tag'), str)
                         and not o['tag'].startswith('cf-') and o.get('tag') != 'api'
                         and o.get('protocol') in SAFE_FALLBACK_PROTOCOLS]
            return {'schema_version': 1, 'revision': s['revision'], 'groups': groups,
                    'audit': audit, 'publication': publication, 'fallbacks': fallbacks}
        except PublisherError as exc:
            if not active_checked and (self.root / 'active.json').exists():
                publication = {'state': 'recovery_required', 'verified_at': None,
                               'message': '发布记录损坏或不可读，需核对私有回执后恢复'}
            if publication['state'] not in ('applying', 'recovery_required'):
                publication['message'] = exc.message
            return {'schema_version': 1, 'revision': None, 'groups': [], 'fallbacks': [],
                    'audit': {'issues': [{'severity': 'error', 'code': exc.code, 'message': exc.message, 'rules': []}],
                              'counts': {'error': 1, 'warning': 0, 'info': 0}}, 'publication': publication}
        except Exception:
            return {'schema_version': 1, 'revision': None, 'groups': [], 'fallbacks': [],
                    'audit': {'issues': [{'severity': 'error', 'code': 'status_unavailable',
                                         'message': '发布状态无法确认', 'rules': []}],
                              'counts': {'error': 1, 'warning': 0, 'info': 0}}, 'publication': publication}

    def preview(self, request):
        if not isinstance(request, dict):
            _fail('invalid_request', '发布请求必须是对象', 422)
        with self._lock():
            self._assert_no_pending()
            snapshot = self._snapshot()
            planned, candidate = self._candidate(snapshot, request)
            dependencies = self._dependencies()
            pin = self._pin()
            if pin['active'] and pin['active'][1] - self.clock() < 120:
                _fail('pin_expiring', '手动路由即将过期，请在其稳定后重新预览', 409)
            observed = self._observe(snapshot['controller'])
            token = secrets.token_urlsafe(24)
            stage = self._stage(token)
            self._mkdir(stage)
            for sub in ('before', 'candidate'):
                self._mkdir(stage / sub)
            for name, raw in snapshot['raw'].items():
                if raw is not None:
                    self._atomic(stage / 'before' / (name + '.json'), raw)
            for name, raw in candidate.items():
                self._atomic(stage / 'candidate' / (name + '.json'), raw)
            self._test(stage / 'candidate/config.json')
            if self._snapshot()['hashes'] != snapshot['hashes'] or self._dependencies() != dependencies:
                _fail('baseline_changed', '预览期间配置或运行依赖已改变，请重新预览')
            self._same_pin(pin)
            audit = planned['audit']
            can_apply = bool(planned['changes']) and not any(i.get('severity') == 'error' for i in audit.get('issues', []))
            plan = {'version': 1, 'preview_id': token, 'request': request,
                    'revision': snapshot['revision'], 'baseline': snapshot['hashes'], 'modes': snapshot['modes'],
                    'dependencies': dependencies, 'pin': pin, 'observed': observed,
                    'candidate': {n: _sha(raw) for n, raw in candidate.items()},
                    'expires_at': self.clock() + PREVIEW_TTL, 'can_apply': can_apply}
            self._atomic(stage / 'plan.json', _encode(plan))
            return {'success': True, 'preview_id': token, 'revision': snapshot['revision'],
                    'expires_at': plan['expires_at'], 'changes': planned['changes'], 'audit': audit,
                    'can_apply': can_apply, 'requires_restart': True}

    def _wait_running(self, label, previous=None):
        for _ in range(12):
            try:
                pid = self._process(label)
                if pid is not None and (previous is None or previous != pid):
                    return pid
            except PublisherError:
                pass
            self.sleep(0.25)
        _fail('service_not_ready', '服务未在限定时间内恢复', 503)

    def _restore_override(self, controller, plan):
        for attempt in range(5):
            self._same_pin(plan['pin'])
            try:
                actual = self._override(controller, allow_empty=True)
                if actual not in ('', plan['observed']['override']):
                    _fail('override_changed', '重启期间出现其它路由覆盖，停止写入旧出口')
                if not actual:
                    self._run([str(self.bin), 'api', 'bo', '--server=' + controller['api'], '-b', 'cf-lisa',
                               plan['observed']['override']], 'override_restore_failed', timeout=3)
                self._same_pin(plan['pin'])
                if self._override(controller) != plan['observed']['override']:
                    _fail('override_readback', '实际出口读回与恢复目标不一致', 503)
                return
            except PublisherError as exc:
                if exc.code not in ('override_unavailable', 'override_restore_failed') or attempt == 4:
                    raise
                self.sleep(0.3)

    def _start_controller(self):
        if self._process(self.controller_label) is None:
            self._run(['/bin/launchctl', 'bootstrap', self.domain, str(self.controller_plist)], 'controller_start_failed')
        return self._wait_running(self.controller_label)

    def _verify_wait(self, controller, minimum, expected):
        deadline = self.clock() + 45
        for _ in range(30):
            try:
                return self._observe(controller, min_updated=minimum, expected_override=expected)
            except PublisherError:
                if self.clock() >= deadline:
                    break
                self.sleep(1)
        _fail('verification_failed', '新进程、实际出口和业务探针未在限定时间内共同通过', 503)

    def _rollback(self, stage, journal, plan, lease):
        try:
            journal['state'] = 'rolling_back'
            self._journal(stage, journal)
            if journal.get('failure_code') in FOREIGN_OVERRIDE_ERRORS:
                _fail('foreign_override_preserved', '外来或歧义覆盖已出现，保留运行现场，不再重启或抢写旧出口')
            # Never overwrite another writer, including when only one file changed.
            for name, path in self.targets.items():
                current = _sha(self._raw(path, name == 'metadata'))
                if current not in (plan['baseline'][name], plan['candidate'][name]):
                    _fail('rollback_conflict', '回退发现其它修改，保留现场')
            if self._process(self.controller_label) is not None:
                self._run(['/bin/launchctl', 'bootout', self.controller_label], 'controller_stop_failed')
            for name, path in self.targets.items():
                current = _sha(self._raw(path, name == 'metadata'))
                if current == plan['baseline'][name]:
                    continue
                if current != plan['candidate'][name]:
                    _fail('rollback_conflict', '回退期间文件已被其它写者修改')
                if plan['baseline'][name] is None:
                    path.unlink()
                else:
                    raw = self._raw(stage / 'before' / (name + '.json'))
                    if _sha(raw) != plan['baseline'][name]:
                        _fail('backup_changed', '回退备份摘要不一致')
                    self._atomic(path, raw, plan['modes'][name])
                journal.setdefault('restored', []).append(name)
                self._journal(stage, journal)
            original = self._snapshot()
            dependencies = self._dependencies()
            if any(value != plan['dependencies'][name] for name, value in dependencies.items() if name != 'pin'):
                _fail('rollback_dependencies_changed', '运行依赖已变化，不能自动回退运行态')
            if not journal.get('restart_attempted') and self._process(self.main_label) != plan['observed']['main_pid']:
                _fail('rollback_main_changed', '主代理已被其它控制者重启，运行态需重新确认')
            if journal.get('restart_attempted'):
                self._run(['/bin/launchctl', 'kickstart', '-k', self.main_label], 'rollback_restart_failed')
                self._wait_running(self.main_label)
                self._restore_override(original['controller'], plan)
            self._same_pin(plan['pin'])
            if lease is not None:
                os.close(lease)
                lease = None
            minimum = self.clock()
            self._start_controller()
            observed = self._verify_wait(original['controller'], minimum, plan['observed']['override'])
            if observed['grok_pid'] != plan['observed']['grok_pid']:
                _fail('grok_changed', '独立 Grok 代理进程发生变化，未宣称保留成功')
            journal.update(state='rolled_back', complete=True, revision=original['revision'], **observed)
            self._journal(stage, journal)
            return {'success': False, 'state': 'rolled_back', 'message': '发布失败，原配置和代理服务已恢复并验证',
                    'applied_at': None, 'revision': original['revision']}
        except Exception as exc:
            # Failed verification/API readiness must not permanently disable a
            # recoverable guardian. Only restart it against a complete owned
            # config/guard generation and unchanged executable/plist/assets.
            # It honours the current pin itself; do not write an old override.
            try:
                current = self._snapshot()
                dependencies = self._dependencies()
                if current['hashes'] not in (plan['baseline'], plan['candidate']):
                    _fail('recovery_generation_unknown', '恢复配置不属于完整的已知版本')
                if any(dependencies[name] != plan['dependencies'][name] for name in IDENTITY_DEPENDENCIES):
                    _fail('recovery_dependencies_changed', '恢复依赖已被其它写者修改')
                if self._process(self.main_label) is None:
                    _fail('main_not_running', '主代理当前未运行', 503)
                if lease is not None:
                    os.close(lease)
                    lease = None
                self._start_controller()
                journal['controller_restored_with_current_pin'] = True
            except Exception:
                journal['controller_restored_with_current_pin'] = False
            journal.update(state='recovery_required', complete=False,
                           recovery_error=exc.code if isinstance(exc, PublisherError) else 'recovery_failed')
            try:
                self._journal(stage, journal)
            except Exception:
                pass
            return {'success': False, 'state': 'recovery_required',
                    'message': '发布未完成，恢复尚未验证；请按 .routing-publish/active.json 回执处理',
                    'applied_at': None, 'revision': None}
        finally:
            if lease is not None:
                os.close(lease)

    def apply(self, preview_id):
        stage = self._stage(preview_id)
        with self._lock():
            self._assert_no_pending()
            self._verify_stage(stage)
            plan = _json(self._raw(stage / 'plan.json'))
            if (plan.get('preview_id') != preview_id or not _number(plan.get('expires_at'))
                    or plan['expires_at'] <= self.clock()):
                _fail('preview_expired', '预览已过期，请重新检查')
            if not plan.get('can_apply'):
                _fail('preview_blocked', '预览未通过或没有需要发布的变化', 422)
            # Compare raw bytes before parsing changed files to classify drift as 409.
            if any(_sha(self._raw(p, n == 'metadata')) != plan['baseline'][n] for n, p in self.targets.items()):
                _fail('baseline_changed', '配置版本已改变，请重新预览')
            if self._dependencies() != plan['dependencies']:
                _fail('dependency_changed', '引擎、资源、pin 或服务文件已改变，请重新预览')
            self._same_pin(plan['pin'])
            snapshot = self._snapshot()
            planned, candidate = self._candidate(snapshot, plan['request'])
            if not planned['changes'] or any(i.get('severity') == 'error' for i in planned['audit'].get('issues', [])):
                _fail('preview_blocked', '当前策略审计不再允许此候选', 422)
            if any(_sha(raw) != plan['candidate'][n] or self._raw(stage / 'candidate' / (n + '.json')) != raw
                   for n, raw in candidate.items()):
                _fail('candidate_changed', '候选不再对应原策略计划，请重新预览')
            if any(_sha(self._raw(stage / 'before' / (n + '.json'))) != value
                   for n, value in plan['baseline'].items() if value is not None):
                _fail('backup_changed', '候选原件备份已改变')
            observed = self._observe(snapshot['controller'])
            if any(observed[name] != plan['observed'][name] for name in ('main_pid', 'controller_pid', 'grok_pid', 'override')):
                _fail('runtime_changed', '运行进程或实际出口已改变，请重新预览')
            self._test(stage / 'candidate/config.json')
            if (self._snapshot()['hashes'] != plan['baseline'] or self._dependencies() != plan['dependencies']
                    or any(self._raw(stage / 'candidate' / (name + '.json')) != raw for name, raw in candidate.items())):
                _fail('baseline_changed', '配置校验期间输入已改变，请重新预览')
            self._same_pin(plan['pin'])
            journal = {'version': 1, 'preview_id': preview_id, 'state': 'controller_stop_requested',
                       'complete': False, 'started_at': self.clock(), 'written': [], 'restart_attempted': False,
                       'dependencies': plan['dependencies']}
            self._journal(stage, journal)
            self._atomic(self.root / 'active.json', _encode({'preview_id': preview_id}))
            lease = None
            try:
                self._run(['/bin/launchctl', 'bootout', self.controller_label], 'controller_stop_failed')
                if self._process(self.controller_label) is not None:
                    _fail('controller_not_stopped', '控制器尚未停止', 503)
                lease = os.open(str(self.runtime / 'state.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if (self._snapshot()['hashes'] != plan['baseline'] or self._dependencies() != plan['dependencies']):
                    _fail('baseline_changed', '停止控制器期间检测到其它修改')
                self._same_pin(plan['pin'])
                if (self._process(self.main_label) != plan['observed']['main_pid']
                        or self._process(self.grok_label) != plan['observed']['grok_pid']
                        or self._override(snapshot['controller']) != plan['observed']['override']):
                    _fail('runtime_changed', '停止控制器期间运行态已改变')
                for name, path in self.targets.items():
                    if _sha(self._raw(path, name == 'metadata')) != plan['baseline'][name]:
                        _fail('baseline_changed', '写入前版本检查失败')
                    self._atomic(path, candidate[name], plan['modes'][name])
                    journal['written'].append(name)
                    journal['state'] = 'writing_files'
                    self._journal(stage, journal)
                if self._snapshot()['hashes'] != plan['candidate']:
                    _fail('write_readback', '发布文件读回与候选不一致')
                self._same_pin(plan['pin'])
                if self._dependencies() != plan['dependencies']:
                    _fail('dependency_changed', '主代理重启前资源或运行依赖已改变')
                if self._process(self.main_label) != plan['observed']['main_pid']:
                    _fail('runtime_changed', '主代理已被其它控制者重启')
                journal.update(state='main_restart_requested', restart_attempted=True)
                self._journal(stage, journal)
                self._run(['/bin/launchctl', 'kickstart', '-k', self.main_label], 'main_restart_failed')
                self._wait_running(self.main_label, previous=observed['main_pid'])
                controller = _json(candidate['controller'])
                self._restore_override(controller, plan)
                journal['state'] = 'controller_start_requested'
                self._journal(stage, journal)
                os.close(lease)
                lease = None
                minimum = self.clock()
                self._start_controller()
                verified = self._verify_wait(controller, minimum, plan['observed']['override'])
                if verified['grok_pid'] != plan['observed']['grok_pid']:
                    _fail('grok_changed', '独立 Grok 代理进程发生变化，未宣称保留成功')
                self._same_pin(plan['pin'])
                final = self._snapshot()
                if final['hashes'] != plan['candidate']:
                    _fail('post_publish_drift', '验收时配置已被其它写者改变')
                if self._dependencies() != plan['dependencies']:
                    _fail('post_publish_dependency_drift', '发布窗口资源或运行依赖已改变，不能确认此次发布')
                journal.update(state='applied', complete=True, revision=final['revision'], **verified)
                self._journal(stage, journal)
                return {'success': True, 'state': 'applied', 'message': '路由已发布，主服务、实际出口和探针验证通过',
                        'applied_at': verified['verified_at'], 'revision': final['revision']}
            except Exception as exc:
                journal['failure_code'] = exc.code if isinstance(exc, PublisherError) else 'publication_failed'
                result = self._rollback(stage, journal, plan, lease)
                lease = None
                return result
            finally:
                if lease is not None:
                    os.close(lease)
