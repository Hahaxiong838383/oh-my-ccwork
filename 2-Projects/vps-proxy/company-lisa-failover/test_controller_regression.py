import importlib.util, inspect, pathlib, sys, unittest
import json, tempfile, subprocess, logging, hashlib
from unittest import mock
source = (pathlib.Path(sys.argv.pop(1)) if __name__ == '__main__' and len(sys.argv) > 1 and not sys.argv[1].startswith('-') else pathlib.Path(__file__).with_name('controller.py'))
spec = importlib.util.spec_from_file_location('candidate', source)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

def decision(p, service, reachable, now, pin=None):
    kwargs = {'pin': pin}
    if 'reachable' in inspect.signature(p.decide).parameters:
        kwargs['reachable'] = reachable
    c = p.decide(service, now, **kwargs)
    p.applied(c, now)
    return c

FALSE = dict.fromkeys(m.NAMES, False)
TRUE = dict.fromkeys(m.NAMES, True)

class Regression(unittest.TestCase):
    def test_target_timeout_does_not_blackhole(self):
        p = m.Policy(selected='dmit')
        # Observed: all Google probes return 204; all Codex probes time out.
        choices = [decision(p, FALSE, TRUE, t) for t in [0, 15]]
        self.assertEqual(choices, ['dmit', 'dmit'])


class PolicyCases(unittest.TestCase):
    def test_three_fully_down_rounds_before_block(self):
        p=m.Policy(selected='dmit')
        self.assertEqual([decision(p,FALSE,FALSE,t) for t in [0,15,30]], ['dmit','dmit','block'])

    def test_cold_start_never_invents_route(self):
        p=m.Policy()
        self.assertEqual([decision(p,FALSE,FALSE,t) for t in [0,15,30]], ['block']*3)

    def test_cold_start_can_use_observed_partial_route(self):
        p=m.Policy()
        self.assertEqual(decision(p,FALSE,dict(dmit=False,zgo=True,home=False),0),'zgo')

    def test_cold_start_prefers_fully_healthy_candidate(self):
        p=m.Policy()
        self.assertEqual(decision(p,dict(dmit=False,zgo=True,home=True),TRUE,0),'zgo')

    def test_degraded_keeps_current_without_churning(self):
        p=m.Policy(selected='home')
        self.assertEqual([decision(p,FALSE,TRUE,t) for t in range(0,901,15)], ['home']*61)

    def test_fully_healthy_candidate_replaces_degraded_after_two_failures(self):
        p=m.Policy(selected='dmit')
        service=dict(dmit=False,zgo=False,home=True)
        self.assertEqual([decision(p,service,TRUE,t) for t in [0,15]],['dmit','home'])

    def test_partial_candidate_replaces_unreachable_current(self):
        p=m.Policy(selected='dmit')
        reachable=dict(dmit=False,zgo=True,home=True)
        self.assertEqual([decision(p,FALSE,reachable,t) for t in [0,15]],['dmit','zgo'])

    def test_full_outage_counter_resets_on_any_reachability(self):
        p=m.Policy(selected='dmit')
        choices=[decision(p,FALSE,FALSE,0),decision(p,FALSE,FALSE,15),decision(p,FALSE,TRUE,30)]
        choices += [decision(p,FALSE,FALSE,t) for t in [45,60,75]]
        self.assertEqual(choices,['dmit']*5+['block'])

    def test_block_recovers_only_to_freshly_observed_route(self):
        p=m.Policy(selected='dmit')
        for t in [0,15,30]: decision(p,FALSE,FALSE,t)
        self.assertEqual(decision(p,dict(dmit=False,zgo=False,home=True),dict(dmit=False,zgo=False,home=True),45),'home')

    def test_higher_priority_requires_300_second_hold(self):
        p=m.Policy(selected='zgo')
        self.assertEqual([decision(p,TRUE,TRUE,t) for t in range(0,300,15)],['zgo']*20)
        self.assertEqual(decision(p,TRUE,TRUE,300),'dmit')

    def test_higher_priority_requires_120_continuous_seconds(self):
        p=m.Policy(selected='zgo')
        lower=dict(dmit=False,zgo=True,home=True)
        for t in range(0,300,15): decision(p,lower,lower,t)
        self.assertEqual([decision(p,TRUE,TRUE,t) for t in range(300,420,15)],['zgo']*8)
        self.assertEqual(decision(p,TRUE,TRUE,420),'dmit')

    def test_partial_higher_priority_does_not_displace_healthy(self):
        p=m.Policy(selected='zgo')
        service=dict(dmit=False,zgo=True,home=True)
        self.assertEqual([decision(p,service,TRUE,t) for t in range(0,601,15)],['zgo']*41)

    def test_one_bad_round_does_not_churn(self):
        p=m.Policy(selected='dmit')
        choices=[]
        for i,t in enumerate(range(0,150,15)):
            choices.append(decision(p,TRUE if i%2 else FALSE,TRUE if i%2 else FALSE,t))
        self.assertEqual(choices,['dmit']*10)

    def test_forward_time_gap_resets_failure_streak(self):
        p=m.Policy(selected='dmit')
        self.assertEqual([decision(p,FALSE,FALSE,t) for t in [0,15,100,115,130]],['dmit']*4+['block'])

    def test_backward_time_jump_resets_failure_streak(self):
        p=m.Policy(selected='dmit')
        self.assertEqual([decision(p,FALSE,FALSE,t) for t in [100,115,90,105,120]],['dmit']*4+['block'])

    def test_time_gap_clears_recovery_evidence(self):
        p=m.Policy(selected='home')
        for t in range(0,300,15): decision(p,TRUE,TRUE,t)
        self.assertEqual(decision(p,TRUE,TRUE,400),'home')

    def test_pin_remains_strict_even_with_partial_reachability(self):
        p=m.Policy(selected='dmit')
        self.assertEqual(decision(p,FALSE,TRUE,0,pin='dmit'),'block')

    def test_pin_only_uses_exact_healthy_requested_route(self):
        p=m.Policy()
        self.assertEqual(decision(p,TRUE,TRUE,0,pin='home'),'home')
        self.assertEqual(decision(p,TRUE,TRUE,15,pin='block'),'block')
        self.assertEqual(decision(p,TRUE,TRUE,30,pin='foreign'),'block')

    def test_pin_ttl_and_auto_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=pathlib.Path(tmp)/'pin.json'
            with mock.patch.object(m.time,'time',return_value=100):
                self.assertIsNone(m.read_pin(path))
                for route,expires,want in [('home',101,'home'),('home',100,None),('auto',101,None)]:
                    path.write_text(json.dumps(dict(route=route,expires=expires)))
                    self.assertEqual(m.read_pin(path),want)

class ProbeCases(unittest.TestCase):
    def test_service_and_reachability_are_distinct(self):
        cfg={'curl':'fake-curl','ports':{'dmit':1,'zgo':2,'home':3},
             'targets':[{'name':'https','url':'redacted1','accept':['204']},
                        {'name':'codex','url':'redacted2','accept':['200','401']}]}
        def probe(curl,port,target):
            ok=port==1 or (port==2 and target['name']=='https')
            return dict(ok=ok,http='204' if ok else '000',exit=0 if ok else 28,kind='ok' if ok else 'transport')
        with mock.patch.object(m,'probe',side_effect=probe):
            service,reachable,detail=m.probe_all(cfg)
        self.assertEqual(service,dict(dmit=True,zgo=False,home=False))
        self.assertEqual(reachable,dict(dmit=True,zgo=True,home=False))

    def test_exactly_two_targets_still_required(self):
        with self.assertRaises(ValueError): m.probe_all({'targets':[]})

    def test_only_expected_http_codes_count(self):
        target={'url':'https://example.invalid/private?secret=must-not-log','accept':['200','401']}
        for code,rc,want,kind in [('401',0,True,'ok'),('403',0,False,'target_rejected'),('000',28,False,'transport')]:
            with mock.patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],rc,code,'secret-body')) as run:
                result=m.probe('curl',10828,target)
            self.assertEqual((result['ok'],result['kind']),(want,kind))
            self.assertNotIn('secret',str(result))
            args=run.call_args.args[0]
            self.assertEqual(args[args.index('--connect-timeout')+1],'8')
            self.assertEqual(args[args.index('--max-time')+1],'12')
            self.assertEqual(run.call_args.kwargs['timeout'],14)

    def test_subprocess_timeout_is_classified_without_output(self):
        with mock.patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('curl',14,output='secret')):
            result=m.probe('curl',10828,dict(url='https://example.invalid',accept=['401']))
        self.assertEqual(result,dict(ok=False,http='000',exit=-1,kind='timeout'))

class GuardCases(unittest.TestCase):
    def test_foreign_override_rejected(self):
        cfg={'tags':{'dmit':'cf-dmit','zgo':'cf-zgo','home':'cf-home','block':'cf-block'},'balancer':'cf-lisa'}
        with mock.patch.object(m,'api',return_value='Selecting Override:\n  1 foreign-route\n'):
            with self.assertRaisesRegex(RuntimeError,'foreign_override_stop'): m.read_override(cfg)

    def test_unknown_override_format_rejected(self):
        with mock.patch.object(m,'api',return_value='unknown secret text'):
            with self.assertRaisesRegex(RuntimeError,'unknown_bi_format'): m.read_override({'balancer':'cf-lisa'})

    def test_readback_mismatch_rejected(self):
        cfg={'balancer':'cf-lisa','tags':{'dmit':'cf-dmit'}}
        with mock.patch.object(m,'api',return_value=''),mock.patch.object(m,'read_override',return_value='block'):
            with self.assertRaisesRegex(RuntimeError,'routing_override_readback_failed'): m.set_choice(cfg,'dmit')

    def one_round(self,service,reachable,guard_ok=True):
        class StopLoop(BaseException): pass
        with tempfile.TemporaryDirectory() as tmp:
            d=pathlib.Path(tmp); production=d/'config.json';production.write_text('private-config')
            cfg={'state':str(d/'state.json'),'pin':str(d/'pin.json'),
                 'guard_config_path':str(production),
                 'guard_config_sha256':hashlib.sha256(production.read_bytes()).hexdigest() if guard_ok else 'invalid',
                 'targets':[{'url':'secret-not-for-logging'}]}
            detail={n:{'https':dict(ok=reachable[n],http='204' if reachable[n] else '000',exit=0 if reachable[n] else 28,kind='ok' if reachable[n] else 'transport'),
                       'codex':dict(ok=service[n],http='401' if service[n] else '000',exit=0 if service[n] else 28,kind='ok' if service[n] else 'transport')} for n in m.NAMES}
            logger=logging.getLogger('failover');before=list(logger.handlers)
            try:
                with mock.patch.object(m,'read_override',return_value='dmit') as read, \
                     mock.patch.object(m,'probe_all',return_value=(service,reachable,detail)) as probes, \
                     mock.patch.object(m,'set_choice',side_effect=AssertionError('unexpected mutation')) as change, \
                     mock.patch.object(m.time,'sleep',side_effect=StopLoop):
                    with self.assertRaises(StopLoop): m.run(cfg)
                state=json.loads((d/'state.json').read_text())
                log=(d/'state.log').read_text()
                self.assertNotIn('secret-not-for-logging',log)
                self.assertNotIn('private-config',log)
                return state,log,read.call_count,probes.call_count,change.call_count
            finally:
                for handler in logger.handlers[:]:
                    if handler not in before: logger.removeHandler(handler);handler.close()

    def test_config_drift_stops_before_probes_or_override(self):
        state,log,reads,probes,changes=self.one_round(FALSE,FALSE,guard_ok=False)
        self.assertEqual((state['status'],state['error_type']),('CONTROL_ERROR','RuntimeError'))
        self.assertEqual((reads,probes,changes),(0,0,0))

    def test_degraded_status_is_written_and_failure_kind_logged(self):
        state,log,*_=self.one_round(FALSE,TRUE)
        self.assertEqual((state['selected'],state['status']),('dmit','DEGRADED'))
        self.assertIn('transport',log)
        self.assertEqual(state['reachable'],TRUE)

    def test_healthy_status_still_ok(self):
        state,*_=self.one_round(TRUE,TRUE)
        self.assertEqual((state['selected'],state['status']),('dmit','OK'))

    def test_all_down_status_before_blackhole_threshold(self):
        state,*_=self.one_round(FALSE,FALSE)
        self.assertEqual((state['selected'],state['status']),('dmit','ALL_DOWN'))
        self.assertEqual(state['all_down_rounds'],1)


class LifecycleCases(unittest.TestCase):
    def exercise(self, rounds=1, api_error=None, probe_restart=False,
                 config_reformat=False, config_semantic_change=False,
                 probe_changes_config=False, service=None, reachable=None, pin=None):
        class StopLoop(BaseException): pass
        service=TRUE if service is None else service
        reachable=TRUE if reachable is None else reachable
        with tempfile.TemporaryDirectory() as tmp:
            d=pathlib.Path(tmp); production=d/'config.json'
            baseline='{"routing":{"balancers":[{"tag":"cf-lisa","selector":["cf-block"],"fallbackTag":"cf-block"}]},"api":{"listen":"loopback"}}'
            raw=json.loads(baseline)
            current=json.dumps(raw,indent=4,sort_keys=True) if config_reformat else baseline
            if config_semantic_change:
                raw['routing']['balancers'][0]['fallbackTag']='unapproved'
                current=json.dumps(raw)
            production.write_text(current)
            cfg={'state':str(d/'state.json'),'pin':str(d/'pin.json'),'guard_config_path':str(production),
                 'guard_config_sha256':hashlib.sha256(baseline.encode()).hexdigest(),
                 'guard_config_semantic_sha256':hashlib.sha256(json.dumps(json.loads(baseline),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest(),
                 'balancer':'cf-lisa','tags':dict(dmit='cf-dmit',zgo='cf-zgo',home='cf-home',block='cf-block')}
            if pin:
                pathlib.Path(cfg['pin']).write_text(json.dumps(dict(route=pin,expires=m.time.time()+300)))
            route=['cf-dmit'];states=[];sleeps=[];mutations=[];calls=[]
            def api(config,command,*args):
                calls.append(command)
                error = api_error(len(calls)) if callable(api_error) else api_error
                if error: raise error
                if command=='bi': return 'Selecting Override:\n  1 '+route[0]+'\n'
                if command=='bo': route[0]=args[-1];mutations.append(args[-1]);return ''
                raise AssertionError('unexpected api')
            detail={n:{'https':dict(ok=reachable[n],http='204' if reachable[n] else '000',exit=0 if reachable[n] else 28,kind='ok' if reachable[n] else 'transport'),
                       'codex':dict(ok=service[n],http='401' if service[n] else '000',exit=0 if service[n] else 28,kind='ok' if service[n] else 'transport')} for n in m.NAMES}
            def probes(config):
                if probe_restart: route[0]=probe_restart if isinstance(probe_restart,str) else 'cf-block'
                if probe_changes_config: production.write_text('{"changed":"secret-config-text"}')
                return service,reachable,detail
            real_atomic=m.atomic_json
            def atomic(path,value):
                real_atomic(path,value)
                if str(path)==cfg['state']: states.append(value.copy())
            def sleep(delay):
                sleeps.append(delay)
                if len(sleeps)>=rounds: raise StopLoop()
            logger=logging.getLogger('failover');before=list(logger.handlers)
            try:
                with mock.patch.object(m,'api',side_effect=api), \
                     mock.patch.object(m,'probe_all',side_effect=probes), \
                     mock.patch.object(m,'atomic_json',side_effect=atomic), \
                     mock.patch.object(m.time,'sleep',side_effect=sleep):
                    with self.assertRaises(StopLoop): m.run(cfg)
                log=(d/'state.log').read_text()
                return dict(states=states,sleeps=sleeps,log=log,route=route[0],mutations=mutations,calls=calls)
            finally:
                for handler in logger.handlers[:]:
                    if handler not in before: logger.removeHandler(handler);handler.close()

    def test_restart_during_probes_is_reconciled_same_round(self):
        r=self.exercise(probe_restart=True)
        self.assertEqual(r['route'],'cf-dmit')
        self.assertEqual(r['mutations'],['cf-dmit'])
        self.assertEqual(r['states'][-1]['status'],'OK')

    def test_json_reformat_remains_controlled(self):
        r=self.exercise(config_reformat=True)
        self.assertEqual(r['states'][-1]['status'],'OK')
        self.assertEqual(r['states'][-1]['guard_match'],'semantic')

    def test_actual_semantic_change_stops_before_api(self):
        r=self.exercise(config_semantic_change=True)
        self.assertEqual(r['states'][-1]['error_code'],'production_config_drift_stop')
        self.assertEqual(r['calls'],[])
        self.assertEqual(r['mutations'],[])

    def test_config_changed_during_probes_stops_before_override(self):
        r=self.exercise(probe_restart=True,probe_changes_config=True)
        self.assertEqual(r['states'][-1]['error_code'],'production_config_drift_stop')
        self.assertEqual(r['mutations'],[])
        self.assertNotIn('secret-config-text',r['log'])

    def test_api_retry_is_fast_and_bounded(self):
        r=self.exercise(rounds=5,api_error=RuntimeError('routing_api_bi_failed'))
        self.assertEqual(r['sleeps'][:3],[2,2,2])
        self.assertTrue(all(x>=13 for x in r['sleeps'][3:]),r['sleeps'])
        self.assertTrue(all(x['error_code']=='routing_api_bi_failed' for x in r['states']))

    def test_foreign_override_does_not_fast_retry(self):
        r=self.exercise(api_error=RuntimeError('foreign_override_stop'))
        self.assertGreaterEqual(r['sleeps'][0],13)
        self.assertEqual(r['states'][-1]['error_code'],'foreign_override_stop')

    def test_unknown_exception_never_logs_secret_message(self):
        r=self.exercise(api_error=RuntimeError('Bearer secret-token-value'))
        self.assertEqual(r['states'][-1]['error_code'],'unexpected_error')
        self.assertNotIn('secret-token-value',str(r['states'])+r['log'])
        self.assertNotIn('Bearer',str(r['states'])+r['log'])

    def test_good_route_timestamp_requires_selected_service_success(self):
        good=self.exercise()['states'][-1]
        self.assertEqual(good['last_good_route'],'dmit')
        self.assertIsInstance(good['last_good_at'],float)
        degraded=self.exercise(service=FALSE,reachable=TRUE)['states'][-1]
        self.assertEqual(degraded['status'],'DEGRADED')
        self.assertIsNone(degraded['last_good_at'])
        self.assertIsNone(degraded['last_good_route'])

    def test_canonical_rejects_duplicate_keys(self):
        with self.assertRaisesRegex(RuntimeError,'production_config_parse_failed'):
            m.canonical_config_sha256(b'{"routing":1,"routing":2}')

    def test_canonical_rejects_non_json_numbers(self):
        with self.assertRaisesRegex(RuntimeError,'production_config_parse_failed'):
            m.canonical_config_sha256(b'{"x":NaN}')

    def test_canonical_does_not_reorder_arrays(self):
        self.assertNotEqual(m.canonical_config_sha256(b'{"rules":[1,2]}'),m.canonical_config_sha256(b'{"rules":[2,1]}'))

    def test_byte_guard_still_works_without_semantic_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=pathlib.Path(tmp)/'config.json';p.write_bytes(b'{"x":1}')
            cfg={'guard_config_path':str(p),'guard_config_sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
            self.assertEqual(m.check_config_guard(cfg),'byte')
            p.write_bytes(b'{ "x": 1 }')
            with self.assertRaisesRegex(RuntimeError,'production_config_drift_stop'):m.check_config_guard(cfg)

    def test_api_timeout_has_safe_specific_code(self):
        with mock.patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('secret-command',5,output='secret-output')):
            with self.assertRaisesRegex(RuntimeError,'^routing_api_bi_timeout$'):
                m.api(dict(xray='fake',api='loopback'),'bi','cf-lisa')

    def test_safe_error_code_accepts_only_whitelist(self):
        for text in ['foreign_override_stop','unknown_bi_format','routing_override_readback_failed',
                     'routing_api_bi_failed','routing_api_bo_failed','routing_api_bi_timeout','routing_api_bo_timeout',
                     'production_config_drift_stop','production_config_parse_failed']:
            self.assertEqual(m.safe_error_code(RuntimeError(text)),text)
        for exc in [RuntimeError({'token':'secret'}),ValueError('secret'),RuntimeError('routing_api_secret_failed')]:
            self.assertEqual(m.safe_error_code(exc),'unexpected_error')


    def test_foreign_override_during_probes_stops_without_mutation(self):
        r=self.exercise(probe_restart='foreign-route')
        self.assertEqual(r['states'][-1]['error_code'],'foreign_override_stop')
        self.assertEqual(r['mutations'],[])

    def test_restart_with_explicit_block_pin_stays_blocked(self):
        r=self.exercise(probe_restart=True,pin='block')
        self.assertEqual(r['route'],'cf-block')
        self.assertEqual(r['mutations'],[])
        self.assertIsNone(r['states'][-1]['last_good_at'])

    def test_last_good_is_retained_but_not_reported_as_current_ok(self):
        r=self.exercise(rounds=2,api_error=lambda n: RuntimeError('routing_api_bi_failed') if n>2 else None)
        a,b=r['states']
        self.assertEqual(a['status'],'OK')
        self.assertEqual(b['status'],'CONTROL_ERROR')
        self.assertEqual(b['last_good_route'],'dmit')
        self.assertEqual(a['last_good_at'],b['last_good_at'])

    def test_success_resets_bounded_fast_retry_streak(self):
        r=self.exercise(rounds=3,api_error=lambda n: RuntimeError('routing_api_bi_failed') if n in (1,4) else None)
        self.assertEqual(r['sleeps'][0],2)
        self.assertGreaterEqual(r['sleeps'][1],13)
        self.assertEqual(r['sleeps'][2],2)

if __name__ == '__main__': unittest.main()
