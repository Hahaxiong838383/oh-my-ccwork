"""Publisher contract tests: real temporary files, fake macOS service boundary."""
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

try:
    import routing_publish as rp
except ModuleNotFoundError as exc:
    if exc.name != 'routing_publish':
        raise
    rp = None


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


class PolicyDouble:
    """Policy semantics have separate tests; only this dependency is substituted."""
    class PolicyError(Exception):
        def __init__(self, code, message):
            self.code, self.message = code, message

    @staticmethod
    def audit_config(config, metadata=None):
        return {'issues': [], 'counts': {'error': 0, 'warning': 0, 'info': 0}}

    @staticmethod
    def group_states(config, metadata=None):
        return [{'tag': 'ordinary', 'enabled': not bool((metadata or {}).get('disabled')),
                 'protected': False, 'rule_indices': [3], 'fallback': None,
                 'nodeTags': ['proxy-a'], 'strategy': 'random'}]

    @classmethod
    def plan_change(cls, config, metadata, request):
        if request.get('tag') == 'cf-lisa':
            raise cls.PolicyError('protected_group', '受保护均衡组不可修改')
        c, m = copy.deepcopy(config), copy.deepcopy(metadata)
        if request.get('enabled') is False:
            c['routing']['rules'][3] = {'domain': ['full:example.test'], 'outboundTag': 'proxy-a'}
            m['disabled']['ordinary'] = {'fallback': 'proxy-a'}
        return {'config': c, 'metadata': m, 'changes': [{'kind': 'toggle', 'rule': 3, 'message': '停用普通组'}],
                'audit': cls.audit_config(c, m)}


class FakeRuntime:
    def __init__(self, home):
        self.home = home
        self.now = 2000000000.0
        self.services = {'com.xray.proxy': 100, 'com.company.lisa-failover': 200, 'com.mycc.grok-bot.proxy': 300}
        self.override = 'cf-dmit'
        self.commands = []
        self.fail_restart = 0
        self.fail_bootstrap = 0
        self.bad_state = False
        self.before_restart = None
        self.fail_test = False
        self.timeout_test = False
        self.before_stop = None
        self.fail_api = 0
        self.secret = 'DO_NOT_LEAK_SUBPROCESS_SECRET'

    def sleep(self, seconds):
        self.now += seconds

    def state(self):
        probes = {n: {'https': {'ok': True, 'http': '204', 'exit': 0},
                      'codex': {'ok': True, 'http': '401', 'exit': 0}}
                  for n in ('dmit', 'zgo', 'home')}
        route = self.override.removeprefix('cf-')
        data = {'updated_at': self.now, 'process_started_at': self.now,
                'status': 'CONTROL_ERROR' if self.bad_state else 'OK', 'selected': route,
                'guard_match': 'byte', 'probes': probes}
        (self.home / 'company-lisa-failover/state.json').write_bytes(encoded(data))

    def run(self, argv, **kwargs):
        self.commands.append(tuple(argv))
        assert kwargs.get('timeout', 0) > 0
        code, stdout = 0, ''
        if Path(argv[0]).name == 'launchctl':
            action = argv[1]
            label = argv[-1].split('/')[-1]
            if action == 'print':
                if label not in self.services:
                    code = 113
                else:
                    stdout = 'state = running\npid = {}\n'.format(self.services[label])
            elif action == 'bootout':
                assert label == 'com.company.lisa-failover'
                if self.before_stop:
                    self.before_stop()
                self.services.pop(label, None)
            elif action == 'bootstrap':
                assert label == 'com.company.lisa-failover.plist'
                if self.fail_bootstrap:
                    self.fail_bootstrap -= 1
                    code = 5
                else:
                    self.services['com.company.lisa-failover'] = 201
                    self.state()
            elif action == 'kickstart':
                assert argv[2] == '-k' and label == 'com.xray.proxy'
                if self.before_restart:
                    hook, self.before_restart = self.before_restart, None
                    hook()
                if self.fail_restart:
                    self.fail_restart -= 1
                    code = 5
                else:
                    self.services[label] += 1
                    self.override = ''
            else:
                raise AssertionError(argv)
        elif argv[1:3] == ['run', '-test']:
            if self.timeout_test:
                raise subprocess.TimeoutExpired(argv, 10, output=self.secret)
            code = int(self.fail_test)
        elif argv[1:3] == ['api', 'bi']:
            stdout = '  - Selecting Override:\n    1   {}\n  - Selects:\n    1   cf-block\n'.format(self.override)
        elif argv[1:3] == ['api', 'bo']:
            assert '-b' in argv and 'cf-lisa' in argv
            if self.fail_api:
                self.fail_api -= 1
                code = 1
            else:
                self.override = argv[-1]
        else:
            raise AssertionError(argv)
        return SimpleNamespace(returncode=code, stdout=stdout, stderr=self.secret)


class AvailabilityTests(unittest.TestCase):
    def test_publisher_contract_exists(self):
        self.assertIsNotNone(rp, 'routing_publish module has not been implemented')


@unittest.skipIf(rp is None, 'publisher not implemented')
class RoutingPublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.userhome = Path(self.temp.name)
        self.home = self.userhome / 'xray'
        self.runtime = self.home / 'company-lisa-failover'
        self.runtime.mkdir(parents=True)
        self.plists = self.userhome / 'Library/LaunchAgents'
        self.plists.mkdir(parents=True)
        tags = {n: 'cf-' + n for n in ('dmit', 'zgo', 'home', 'block')}
        self.config = {'api': {'tag': 'cf-api', 'listen': '127.0.0.1:14991', 'services': ['RoutingService']},
                       'inbounds': [], 'outbounds': [{'tag': t, 'protocol': 'blackhole' if t == 'cf-block' else 'socks'}
                                                   for t in ['proxy-a', 'cf-dmit', 'cf-zgo', 'cf-home', 'cf-block']],
                       'routing': {'domainStrategy': 'AsIs', 'rules': [
                           {'inboundTag': ['cf-probe-' + n], 'outboundTag': 'cf-' + n}
                           for n in ('dmit', 'zgo', 'home')] + [
                           {'domain': ['full:example.test'], 'balancerTag': 'ordinary'}],
                           'balancers': [{'tag': 'cf-lisa', 'selector': ['cf-block'], 'fallbackTag': 'cf-block',
                                          'strategy': {'type': 'random'}},
                                         {'tag': 'ordinary', 'selector': ['proxy-a'], 'strategy': {'type': 'random'}}]}}
        core = encoded(self.config)
        self.cfg = {'xray': str(self.home / 'xray'), 'curl': '/usr/bin/curl',
                    'api': '127.0.0.1:14991', 'balancer': 'cf-lisa', 'tags': tags,
                    'ports': {'dmit': 10828, 'zgo': 10829, 'home': 10830},
                    'targets': [{'name': 'https', 'url': 'https://www.google.com/generate_204', 'accept': ['204']},
                                {'name': 'codex', 'url': 'https://chatgpt.com/backend-api/codex/models', 'accept': ['200', '401']}],
                    'state': str(self.runtime / 'state.json'), 'pin': str(self.runtime / 'pin.json'),
                    'guard_config_path': str(self.home / 'config.json'), 'guard_config_sha256': digest(core)}
        (self.home / 'config.json').write_bytes(core)
        (self.home / 'config.json').chmod(0o640)
        (self.runtime / 'controller.json').write_bytes(encoded(self.cfg))
        (self.runtime / 'controller.json').chmod(0o600)
        (self.runtime / 'controller.py').write_text('# fixture\n')
        (self.home / 'xray').write_bytes(b'fixture executable')
        (self.home / 'xray').chmod(0o700)
        for name in ('geoip.dat', 'geosite.dat'):
            (self.home / name).write_bytes(b'asset')
        for label, args in [
            ('com.xray.proxy', [str(self.home / 'xray'), 'run', '-c', str(self.home / 'config.json')]),
            ('com.company.lisa-failover', ['/usr/bin/python3', '-B', str(self.runtime / 'controller.py'),
                                           '--config', str(self.runtime / 'controller.json')])]:
            (self.plists / (label + '.plist')).write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': args}))
        self.fake = FakeRuntime(self.home)
        self.fake.state()
        self.policy_patch = patch.object(rp, 'policy', PolicyDouble)
        self.policy_patch.start()
        self.addCleanup(self.policy_patch.stop)
        self.publisher = rp.RoutingPublisher(self.home, runner=self.fake.run,
                                             clock=lambda: self.fake.now, sleeper=self.fake.sleep)
        self.request = {'action': 'toggle', 'tag': 'ordinary', 'enabled': False, 'fallback': 'proxy-a'}

    def preview(self):
        return self.publisher.preview(self.request)

    def originals(self):
        return {p: p.read_bytes() for p in (self.home / 'config.json', self.runtime / 'controller.json')}

    def assert_originals(self, old):
        for p, raw in old.items():
            self.assertEqual(p.read_bytes(), raw)

    def test_preview_stages_all_candidates_without_service_or_production_write(self):
        old = self.originals()
        result = self.preview()
        self.assertTrue(result['can_apply'])
        self.assertTrue(result['requires_restart'])
        self.assert_originals(old)
        self.assertFalse((self.home / 'routing-policy.json').exists())
        self.assertNotIn('DO_NOT_LEAK', json.dumps(result))
        self.assertFalse(any(c[1] in ('bootout', 'bootstrap', 'kickstart') for c in self.fake.commands))

    def test_apply_updates_persistent_guard_restores_override_and_leaves_other_services_alone(self):
        result = self.publisher.apply(self.preview()['preview_id'])
        self.assertEqual((result['success'], result['state']), (True, 'applied'))
        cfg = json.loads((self.runtime / 'controller.json').read_text())
        self.assertEqual(cfg['guard_config_sha256'], digest((self.home / 'config.json').read_bytes()))
        self.assertIn('guard_config_semantic_sha256', cfg)
        self.assertEqual(self.fake.override, 'cf-dmit')
        self.assertEqual((self.home / 'config.json').stat().st_mode & 0o777, 0o640)
        self.assertEqual(json.loads((self.home / 'config.json').read_text())['routing']['rules'][3],
                         {'domain': ['full:example.test'], 'outboundTag': 'proxy-a'})
        self.assertEqual(self.publisher.status()['publication']['state'], 'applied')
        self.assertFalse(any(('grok' in ' '.join(c).lower() and c[1] != 'print')
                             or c[0] in ('pkill', 'killall') for c in self.fake.commands))

    def test_config_controller_metadata_and_pin_drift_each_reject_before_stopping(self):
        for path in (self.home / 'config.json', self.runtime / 'controller.json',
                     self.home / 'routing-policy.json', self.runtime / 'pin.json'):
            with self.subTest(path=path.name):
                preview = self.preview()
                existed = path.exists()
                before = path.read_bytes() if existed else None
                path.write_bytes(b'{}')
                start = len(self.fake.commands)
                with self.assertRaises(rp.PublisherError) as error:
                    self.publisher.apply(preview['preview_id'])
                self.assertEqual(error.exception.status_code, 409)
                self.assertFalse(any(c[1] == 'bootout' for c in self.fake.commands[start:]))
                path.write_bytes(before) if existed else path.unlink()

    def test_expired_or_path_traversal_token_never_changes_config(self):
        old = self.originals()
        result = self.preview()
        self.fake.now = result['expires_at'] + 1
        for token in (result['preview_id'], '../config.json', '', 4):
            with self.assertRaises(rp.PublisherError):
                self.publisher.apply(token)
        self.assert_originals(old)

    def test_invalid_core_test_and_timeout_are_redacted_no_stop(self):
        for attribute in ('fail_test', 'timeout_test'):
            setattr(self.fake, attribute, True)
            with self.assertRaises(rp.PublisherError) as error:
                self.preview()
            self.assertNotIn(self.fake.secret, str(error.exception))
            self.assertFalse(any(c[1] == 'bootout' for c in self.fake.commands))
            setattr(self.fake, attribute, False)

    def test_restart_failure_rolls_back_only_owned_files_and_restores_controller(self):
        old = self.originals()
        preview = self.preview()
        self.fake.fail_restart = 1
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual((result['success'], result['state']), (False, 'rolled_back'))
        self.assert_originals(old)
        self.assertFalse((self.home / 'routing-policy.json').exists())
        self.assertIn('com.company.lisa-failover', self.fake.services)
        self.assertEqual(self.fake.override, 'cf-dmit')

    def test_rollback_conflict_preserves_foreign_edit_and_blocks_next_apply(self):
        preview = self.preview()
        self.fake.fail_restart = 1
        self.fake.before_restart = lambda: (self.home / 'config.json').write_bytes(b'foreign config')
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'recovery_required')
        self.assertEqual((self.home / 'config.json').read_bytes(), b'foreign config')
        with self.assertRaises(rp.PublisherError):
            self.publisher.apply(preview['preview_id'])

    def test_pin_changed_during_restart_never_restores_stale_override(self):
        preview = self.preview()
        self.fake.before_restart = lambda: (self.runtime / 'pin.json').write_bytes(
            encoded({'route': 'zgo', 'expires': self.fake.now + 900}))
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'recovery_required')
        self.assertFalse(any(c[1:3] == ('api', 'bo') for c in self.fake.commands))
        self.assertIn('com.company.lisa-failover', self.fake.services)

    def test_api_initialization_retry_does_not_force_unnecessary_rollback(self):
        preview = self.preview()
        self.fake.fail_api = 2
        result = self.publisher.apply(preview['preview_id'])
        self.assertTrue(result['success'])
        self.assertEqual(self.fake.override, 'cf-dmit')
        self.assertEqual(self.fake.services['com.xray.proxy'], 101)

    def test_fallbacks_exclude_freedom_and_unknown_protocol(self):
        core = json.loads((self.home / 'config.json').read_text())
        core['outbounds'].extend([{'tag': 'direct', 'protocol': 'freedom'}, {'tag': 'loop', 'protocol': 'loopback'}])
        raw = encoded(core)
        (self.home / 'config.json').write_bytes(raw)
        cfg = json.loads((self.runtime / 'controller.json').read_text())
        cfg['guard_config_sha256'] = digest(raw)
        (self.runtime / 'controller.json').write_bytes(encoded(cfg))
        self.assertEqual(self.publisher.status()['fallbacks'], [{'tag': 'proxy-a', 'protocol': 'socks'}])

    def test_grok_restart_during_publication_is_reported_not_claimed_preserved(self):
        preview = self.preview()
        self.fake.before_restart = lambda: self.fake.services.update({'com.mycc.grok-bot.proxy': 301})
        result = self.publisher.apply(preview['preview_id'])
        self.assertFalse(result['success'])

    def test_candidate_cannot_reorder_protected_probe_rules(self):
        original = PolicyDouble.plan_change
        def changed(config, metadata, request):
            result = original(config, metadata, request)
            rules = result['config']['routing']['rules']
            result['config']['routing']['rules'] = rules[3:] + rules[:3]
            return result
        with patch.object(PolicyDouble, 'plan_change', side_effect=changed):
            with self.assertRaises(rp.PublisherError):
                self.preview()

    def test_preview_directory_symlink_cannot_select_another_plan(self):
        preview = self.preview()
        stage = self.home / '.routing-publish/previews' / preview['preview_id']
        moved = self.userhome / 'other'
        stage.rename(moved)
        stage.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(rp.PublisherError):
            self.publisher.apply(preview['preview_id'])

    def test_failed_recovery_never_returns_success(self):
        preview = self.preview()
        self.fake.fail_restart = 2
        result = self.publisher.apply(preview['preview_id'])
        self.assertFalse(result['success'])
        self.assertEqual(result['state'], 'recovery_required')
        self.assertEqual(self.publisher.status()['publication']['state'], 'recovery_required')

    def test_api_failure_recovery_keeps_guardian_running_without_claiming_verified(self):
        preview = self.preview()
        self.fake.fail_api = 10
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'recovery_required')
        self.assertIn('com.company.lisa-failover', self.fake.services)

    def test_controller_bootstrap_failure_rolls_back_then_recovers_service(self):
        old = self.originals()
        preview = self.preview()
        self.fake.fail_bootstrap = 1
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'rolled_back')
        self.assert_originals(old)
        self.assertIn('com.company.lisa-failover', self.fake.services)

    def test_partial_file_write_failure_restores_all_original_bytes_and_modes(self):
        old = self.originals()
        preview = self.preview()
        original = self.publisher._atomic
        failed = []
        def write(path, raw, mode=0o600):
            if path == self.runtime / 'controller.json' and not failed:
                failed.append(True)
                raise OSError('DO_NOT_LEAK_OS_ERROR')
            return original(path, raw, mode)
        with patch.object(self.publisher, '_atomic', side_effect=write):
            result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'rolled_back')
        self.assert_originals(old)
        self.assertNotIn('DO_NOT_LEAK', json.dumps(result))

    def test_service_identity_drift_before_stop_rejects_without_restart(self):
        preview = self.preview()
        self.fake.services['com.xray.proxy'] = 101
        with self.assertRaises(rp.PublisherError) as error:
            self.publisher.apply(preview['preview_id'])
        self.assertEqual(error.exception.status_code, 409)
        self.assertFalse(any(c[1] in ('bootout', 'kickstart') for c in self.fake.commands))

    def test_concurrent_publisher_lock_rejects(self):
        preview = self.preview()
        with self.publisher._lock():
            other = rp.RoutingPublisher(self.home, runner=self.fake.run)
            with self.assertRaises(rp.PublisherError) as error:
                other.apply(preview['preview_id'])
        self.assertEqual(error.exception.status_code, 423)

    def test_foreign_guard_drift_during_stop_is_preserved(self):
        preview = self.preview()
        self.fake.before_stop = lambda: (self.runtime / 'controller.json').write_bytes(b'{"foreign":true}')
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'recovery_required')
        self.assertEqual((self.runtime / 'controller.json').read_bytes(), b'{"foreign":true}')

    def test_pending_publication_status_does_not_become_green_after_restart(self):
        preview = self.preview()
        self.fake.fail_restart = 2
        self.publisher.apply(preview['preview_id'])
        self.fake.fail_restart = 0
        self.fake.override = 'cf-dmit'
        self.fake.services['com.company.lisa-failover'] = 202
        self.fake.state()
        self.assertEqual(self.publisher.status()['publication']['state'], 'recovery_required')

    def test_validated_candidate_cannot_change_any_outbound_credentials(self):
        original = PolicyDouble.plan_change
        def changed(config, metadata, request):
            result = original(config, metadata, request)
            result['config']['outbounds'][0]['settings'] = {'password': 'DO_NOT_LEAK'}
            return result
        with patch.object(PolicyDouble, 'plan_change', side_effect=changed):
            with self.assertRaises(rp.PublisherError) as error:
                self.preview()
        self.assertNotIn('DO_NOT_LEAK', str(error.exception))

    def test_actual_policy_publisher_persistent_toggle_and_restore(self):
        with patch.object(rp, 'policy', importlib.import_module('routing_policy')):
            result = self.publisher.apply(self.preview()['preview_id'])
            self.assertTrue(result['success'])
            request = {'action': 'toggle', 'tag': 'ordinary', 'enabled': True}
            restored = self.publisher.apply(self.publisher.preview(request)['preview_id'])
            self.assertTrue(restored['success'])
            self.assertEqual(json.loads((self.home / 'config.json').read_text()), self.config)

    def test_corrupt_active_journal_shows_recovery_required_not_unverified(self):
        self.preview()
        (self.home / '.routing-publish/active.json').write_bytes(b'not-json')
        self.assertEqual(self.publisher.status()['publication']['state'], 'recovery_required')
        with self.assertRaises(rp.PublisherError):
            self.preview()

    def test_main_restarted_by_other_writer_during_stop_cannot_claim_applied(self):
        old = self.originals()
        preview = self.preview()
        self.fake.before_stop = lambda: self.fake.services.update({'com.xray.proxy': 101})
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'recovery_required')
        self.assert_originals(old)
        self.assertFalse(any(c[1] == 'kickstart' for c in self.fake.commands))

    def test_asset_changed_during_restart_is_not_reported_applied(self):
        preview = self.preview()
        self.fake.before_restart = lambda: (self.home / 'geosite.dat').write_bytes(b'foreign replacement asset')
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'recovery_required')
        self.assertFalse(result['success'])
        self.assertEqual((self.home / 'geosite.dat').read_bytes(), b'foreign replacement asset')
        self.assertIn('com.company.lisa-failover', self.fake.services)

    def test_asset_update_after_complete_receipt_is_distinguished_from_publish_failure(self):
        self.assertTrue(self.publisher.apply(self.preview()['preview_id'])['success'])
        (self.home / 'geosite.dat').write_bytes(b'later downloaded asset')
        status = self.publisher.status()['publication']
        self.assertEqual(status['state'], 'applied')
        self.assertTrue(status.get('disk_assets_changed'))

    def test_controller_code_changed_after_publish_no_longer_claims_same_verified_runtime(self):
        self.publisher.apply(self.preview()['preview_id'])
        (self.runtime / 'controller.py').write_bytes(b'changed code')
        self.assertEqual(self.publisher.status()['publication']['state'], 'unverified')

    def test_foreign_override_during_restart_is_preserved_without_second_restart(self):
        preview = self.preview()
        runner = self.fake.run
        injected = []
        def run(argv, **kwargs):
            if (argv[1:3] == ['api', 'bi'] and self.fake.services['com.xray.proxy'] > 100 and not injected):
                self.fake.override = 'foreign-node'
                injected.append(True)
            return runner(argv, **kwargs)
        self.publisher.runner = run
        result = self.publisher.apply(preview['preview_id'])
        self.assertEqual(result['state'], 'recovery_required')
        self.assertEqual(self.fake.override, 'foreign-node')
        self.assertEqual(self.fake.services['com.xray.proxy'], 101)
        self.assertFalse(any(c[1:3] == ('api', 'bo') for c in self.fake.commands))
        self.assertIn('com.company.lisa-failover', self.fake.services)

    def test_backup_and_journal_private_and_no_pending_cleared(self):
        pending = self.home / 'rule-updater.pending.json'
        pending.write_bytes(b'pending evidence')
        self.publisher.apply(self.preview()['preview_id'])
        self.assertEqual(pending.read_bytes(), b'pending evidence')
        for p in (self.home / '.routing-publish').rglob('*'):
            self.assertEqual(p.stat().st_mode & 0o777, 0o700 if p.is_dir() else 0o600)

    def test_unfinished_transaction_blocks_new_write_after_new_publisher(self):
        preview = self.preview()
        self.fake.fail_restart = 2
        self.publisher.apply(preview['preview_id'])
        other = rp.RoutingPublisher(self.home, runner=self.fake.run,
                                    clock=lambda: self.fake.now, sleeper=self.fake.sleep)
        self.assertEqual(other.status()['publication']['state'], 'recovery_required')
        with self.assertRaises(rp.PublisherError):
            other.preview(self.request)

    def test_unknown_override_stale_health_or_failed_probe_blocks_publication(self):
        self.fake.override = 'foreign-node'
        with self.assertRaises(rp.PublisherError):
            self.preview()
        self.fake.override = 'cf-dmit'
        statefile = self.runtime / 'state.json'
        state = json.loads(statefile.read_text())
        state['updated_at'] -= 46
        statefile.write_bytes(encoded(state))
        with self.assertRaises(rp.PublisherError):
            self.preview()
        self.fake.state()
        state = json.loads(statefile.read_text())
        state['probes']['dmit']['codex']['ok'] = False
        statefile.write_bytes(encoded(state))
        with self.assertRaises(rp.PublisherError):
            self.preview()


if __name__ == '__main__':
    unittest.main()
