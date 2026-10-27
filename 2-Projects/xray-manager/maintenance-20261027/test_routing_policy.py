import copy
import json
import unittest
from routing_policy import audit_config, group_states, plan_change, PolicyError


def fixture():
    return {'routing': {'domainStrategy':'AsIs','rules':[
        {'type':'field','inboundTag':['cf-probe-dmit'],'outboundTag':'cf-dmit'},
        {'type':'field','domain':['domain:google.com'],'outboundTag':'proxy'},
        {'type':'field','domain':['domain:api.google.com','domain:else.invalid'],'balancerTag':'web'},
        {'type':'field','network':'tcp,udp','outboundTag':'proxy'}],
        'balancers':[{'tag':'web','selector':['proxy'],'fallbackTag':'backup','strategy':{'type':'leastPing'}},
                     {'tag':'cf-lisa','selector':['cf-block'],'fallbackTag':'cf-block','strategy':{'type':'random'}}]},
        'outbounds':[{'tag':t,'protocol':p} for t,p in [('proxy','vless'),('backup','vless'),('cf-dmit','vless'),('cf-block','blackhole'),('direct','freedom')]],
        'inbounds':[{'tag':'cf-probe-dmit'},{'tag':'socks'}], 'observatory':{'subjectSelector':['proxy']}}

class PolicyTests(unittest.TestCase):
    def codes(self,c):return [i['code'] for i in audit_config(c)['issues']]
    def plan(self,c,request,meta=None):return plan_change(c,meta or {'version':1,'disabled':{}},request)
    def test_cross_target_shadow_is_reported(self):
        issues=audit_config(fixture())['issues']
        self.assertTrue(any(i['code']=='shadowed_condition' and i['rules']==[1,2] for i in issues))
    def test_normalize_preserves_first_winner_not_later_intention(self):
        c=fixture();p=self.plan(c,{'action':'normalize'})
        self.assertEqual(p['config']['routing']['rules'][2]['domain'],['domain:else.invalid'])
        self.assertEqual(c,fixture())
    def test_toggle_requires_explicit_non_direct_fallback(self):
        for fallback in [None,'direct','absent']:
            with self.assertRaises(PolicyError):self.plan(fixture(),{'action':'toggle','tag':'web','enabled':False,'fallback':fallback})
    def test_toggle_restores_exact_conditions_and_positions(self):
        c=fixture();c['routing']['rules'][2].update(port='443',network='tcp',source=['10.0.0.0/8'])
        p=self.plan(c,{'action':'toggle','tag':'web','enabled':False,'fallback':'backup'})
        rule=p['config']['routing']['rules'][2]
        self.assertEqual(rule['outboundTag'],'backup');self.assertNotIn('balancerTag',rule)
        self.assertEqual(rule['source'],['10.0.0.0/8'])
        q=self.plan(p['config'],{'action':'toggle','tag':'web','enabled':True},p['metadata'])
        self.assertEqual(q['config'],c);self.assertEqual(q['metadata']['disabled'],{})
    def test_disabled_snapshot_drift_is_refused(self):
        p=self.plan(fixture(),{'action':'toggle','tag':'web','enabled':False,'fallback':'backup'})
        p['config']['routing']['rules'][2]['port']='80'
        with self.assertRaises(PolicyError):self.plan(p['config'],{'action':'toggle','tag':'web','enabled':True},p['metadata'])
    def test_protected_group_is_refused(self):
        with self.assertRaises(PolicyError):self.plan(fixture(),{'action':'toggle','tag':'cf-lisa','enabled':False,'fallback':'backup'})
    def test_normalize_is_refused_while_group_disabled(self):
        p=self.plan(fixture(),{'action':'toggle','tag':'web','enabled':False,'fallback':'backup'})
        with self.assertRaises(PolicyError):self.plan(p['config'],{'action':'normalize'},p['metadata'])
    def test_missing_balancer_and_outbound_are_errors(self):
        for key in ['outboundTag','balancerTag']:
            c=fixture();c['routing']['rules'].append({'domain':['domain:x.invalid'],key:'missing'})
            self.assertIn('missing_target',self.codes(c))
    def test_both_targets_is_error(self):
        c=fixture();c['routing']['rules'][2]['outboundTag']='backup'
        self.assertIn('ambiguous_target',self.codes(c))
    def test_empty_selector_and_prefix_overlap(self):
        c=fixture();c['routing']['balancers'][0]['selector']=['missing']
        self.assertIn('empty_selector',self.codes(c))
        c=fixture();c['routing']['balancers'][0]['selector']=['proxy','pro']
        self.assertIn('overlapping_selectors',self.codes(c))
    def test_domain_and_ip_are_not_or(self):
        c=fixture();c['routing']['rules'][1]['ip']=['1.2.3.0/24']
        self.assertIn('domain_ip_and',self.codes(c))
        p=self.plan(c,{'action':'normalize'})
        self.assertEqual(p['config']['routing']['rules'][2]['domain'],c['routing']['rules'][2]['domain'])
    def test_narrow_port_cannot_shadow_wider_rule(self):
        c=fixture();c['routing']['rules'][1]['port']='443'
        p=self.plan(c,{'action':'normalize'})
        self.assertEqual(p['config']['routing']['rules'][2]['domain'],c['routing']['rules'][2]['domain'])
    def test_domain_boundary_not_string_suffix(self):
        c=fixture();c['routing']['rules'][2]['domain']=['domain:notgoogle.com']
        p=self.plan(c,{'action':'normalize'})
        self.assertEqual(p['config']['routing']['rules'][2]['domain'],['domain:notgoogle.com'])
    def test_regex_and_geosite_are_not_guessed(self):
        c=fixture();c['routing']['rules'][1]['domain']=['regexp:.*google.*','geosite:google']
        p=self.plan(c,{'action':'normalize'})
        self.assertEqual(p['config']['routing']['rules'][2]['domain'],c['routing']['rules'][2]['domain'])
        self.assertIn('opaque_matcher',self.codes(c))
    def test_internal_subdomain_and_cidr_redundancy(self):
        c=fixture();c['routing']['rules'][1]['domain']=['domain:api.google.com','domain:google.com','domain:google.com']
        c['routing']['rules'].insert(1,{'ip':['10.9.1.0/24','10.0.0.0/8'],'outboundTag':'direct'})
        p=self.plan(c,{'action':'normalize'})
        self.assertEqual(p['config']['routing']['rules'][1]['ip'],['10.0.0.0/8'])
        self.assertEqual(p['config']['routing']['rules'][2]['domain'],['domain:google.com'])
    def test_unknown_predicate_is_preserved(self):
        c=fixture();c['routing']['rules'][1]['attrs']='some.expression'
        p=self.plan(c,{'action':'normalize'})
        self.assertEqual(p['config']['routing']['rules'][2]['domain'],c['routing']['rules'][2]['domain'])
    def test_full_shadowed_rule_removed_without_catchall_conversion(self):
        c=fixture();c['routing']['rules'][2]['domain']=['domain:api.google.com']
        p=self.plan(c,{'action':'normalize'})
        self.assertEqual(len(p['config']['routing']['rules']),3)
        self.assertEqual(p['config']['routing']['rules'][-1]['network'],'tcp,udp')
    def test_normalize_idempotent(self):
        p=self.plan(fixture(),{'action':'normalize'});q=self.plan(p['config'],{'action':'normalize'})
        self.assertEqual(p['config'],q['config']);self.assertEqual(q['changes'],[])
    def test_invalid_hostname_is_warning_and_not_auto_corrected(self):
        c=fixture();c['routing']['rules'][1]['domain']=['full:example.com/']
        self.assertIn('invalid_domain',self.codes(c))
        self.assertEqual(self.plan(c,{'action':'normalize'})['config']['routing']['rules'][1]['domain'],['full:example.com/'])
    def test_enabled_type_is_strict(self):
        for value in ['false',0,None]:
            with self.assertRaises(PolicyError):self.plan(fixture(),{'action':'toggle','tag':'web','enabled':value,'fallback':'backup'})
    def test_unknown_group_and_action_refused(self):
        for r in [{'action':'other'},{'action':'toggle','tag':'missing','enabled':True}]:
            with self.assertRaises(PolicyError):self.plan(fixture(),r)
    def test_metadata_unknown_or_corrupt_refused(self):
        for m in [{'version':2,'disabled':{}},{'version':1,'disabled':[]}]:
            with self.assertRaises(PolicyError):self.plan(fixture(),{'action':'normalize'},m)
    def test_probe_rule_never_changed(self):
        c=fixture();c['routing']['rules'][0]['domain']=['domain:x.invalid','domain:x.invalid']
        self.assertEqual(self.plan(c,{'action':'normalize'})['config']['routing']['rules'][0],c['routing']['rules'][0])
    def test_disabled_group_state_is_explicit(self):
        p=self.plan(fixture(),{'action':'toggle','tag':'web','enabled':False,'fallback':'backup'})
        group=next(x for x in group_states(p['config'],p['metadata']) if x['tag']=='web')
        self.assertFalse(group['enabled']);self.assertEqual(group['fallback'],'backup');self.assertEqual(group['rule_indices'],[2])
    def test_secret_fields_not_in_audit(self):
        c=fixture();c['outbounds'][0]['settings']={'password':'DO_NOT_EXPORT_CREDENTIAL'}
        self.assertNotIn('DO_NOT_EXPORT_CREDENTIAL',json.dumps(audit_config(c)))

if __name__=='__main__':unittest.main()
