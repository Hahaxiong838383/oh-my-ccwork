import copy
import json
import unittest
import routing_policy as policy
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

class ChatGPTRouteTests(unittest.TestCase):
    def config(self):
        c=fixture()
        c['api']={'tag':'api'}
        c['inbounds'].append({'tag':'api'})
        c['routing']['rules'].insert(0,{'type':'field','inboundTag':['api'],'outboundTag':'api'})
        c['routing']['rules'].insert(2,{'type':'field','domain':['domain:chatgpt.com','domain:unrelated.invalid'],'balancerTag':'web'})
        c['outbounds'].append({'tag':'independent-us','protocol':'vless','settings':{'id':'PRIVATE_TEST_VALUE'}})
        return c

    def enable(self,c=None,meta=None,outbound='independent-us'):
        try:
            return plan_change(self.config() if c is None else c,meta,
                               {'action':'domain_route','enabled':True,'outbound':outbound})
        except PolicyError as e:
            self.fail('启用预定义域名路由被拒绝: '+e.code)

    def refuse(self,c,meta,request,code=None):
        with self.assertRaises(PolicyError) as caught:plan_change(c,meta,request)
        if code:self.assertEqual(caught.exception.code,code)

    def test_enable_inserts_before_old_target_without_changing_original_rules(self):
        original=self.config();p=self.enable(original);rules=p['config']['routing']['rules']
        self.assertEqual(rules[:2],original['routing']['rules'][:2])
        self.assertEqual(rules[2]['outboundTag'],'independent-us')
        self.assertTrue(rules[2].get('ruleTag'))
        self.assertEqual(rules[2]['domain'],['domain:chatgpt.com'])
        self.assertEqual(rules[3:],original['routing']['rules'][2:])
        self.assertEqual(original,self.config())
        self.assertEqual(p['config']['outbounds'],original['outbounds'])

    def test_disable_restores_exact_original_configuration_and_metadata(self):
        original=self.config();p=self.enable(original)
        q=plan_change(p['config'],p['metadata'],{'action':'domain_route','enabled':False})
        self.assertEqual(q['config'],original)
        self.assertEqual(q['metadata'],{'version':1,'disabled':{}})
        self.assertTrue(q['changes'])

    def test_same_target_and_already_disabled_are_idempotent(self):
        p=self.enable();q=self.enable(p['config'],p['metadata'])
        self.assertEqual(q['config'],p['config']);self.assertEqual(q['metadata'],p['metadata']);self.assertEqual(q['changes'],[])
        q=plan_change(self.config(),None,{'action':'domain_route','enabled':False})
        self.assertEqual(q['config'],self.config());self.assertEqual(q['changes'],[])

    def test_target_change_only_replaces_owned_rule_and_remains_reversible(self):
        p=self.enable();q=self.enable(p['config'],p['metadata'],outbound='backup')
        self.assertEqual(q['config']['routing']['rules'][2]['outboundTag'],'backup')
        self.assertEqual(q['config']['routing']['rules'][:2],p['config']['routing']['rules'][:2])
        self.assertEqual(q['config']['routing']['rules'][3:],p['config']['routing']['rules'][3:])
        r=plan_change(q['config'],q['metadata'],{'action':'domain_route','enabled':False})
        self.assertEqual(r['config'],self.config())

    def test_unknown_client_domains_and_extra_fields_are_rejected(self):
        for extra in [{'domains':['domain:evil.invalid']},{'profile':'other'},{'config':{}},{'fallback':'direct'}]:
            with self.subTest(extra=extra):
                self.refuse(self.config(),None,dict(action='domain_route',enabled=True,outbound='independent-us',**extra),'invalid_request')

    def test_enabled_and_outbound_types_are_strict(self):
        for enabled in [None,0,1,'true']:
            self.refuse(self.config(),None,{'action':'domain_route','enabled':enabled,'outbound':'independent-us'},'invalid_request')
        for outbound in [None,[],0,'','absent','direct','cf-block','cf-dmit']:
            self.refuse(self.config(),None,{'action':'domain_route','enabled':True,'outbound':outbound},'invalid_domain_outbound')
        self.refuse(self.config(),None,{'action':'domain_route','enabled':False,'outbound':'independent-us'},'invalid_request')

    def test_managed_selector_and_probe_targets_are_not_available(self):
        c=self.config();c['routing']['balancers'][1]['selector']=['independent-']
        self.refuse(c,None,{'action':'domain_route','enabled':True,'outbound':'independent-us'},'invalid_domain_outbound')
        c=self.config();c['routing']['rules'][1]['outboundTag']='independent-us'
        self.refuse(c,None,{'action':'domain_route','enabled':True,'outbound':'independent-us'},'invalid_domain_outbound')

    def test_chained_target_is_not_accepted_as_independent_outbound(self):
        for extra in [{'proxySettings':{'tag':'cf-dmit'}},{'streamSettings':{'sockopt':{'dialerProxy':'cf-dmit'}}}]:
            c=self.config();c['outbounds'][-1].update(extra)
            self.refuse(c,None,{'action':'domain_route','enabled':True,'outbound':'independent-us'},'invalid_domain_outbound')

    def test_duplicate_target_is_rejected(self):
        c=self.config();c['outbounds'].append(copy.deepcopy(c['outbounds'][-1]))
        self.refuse(c,None,{'action':'domain_route','enabled':True,'outbound':'independent-us'},'config_conflict')

    def test_disabled_group_metadata_blocks_domain_insertion(self):
        p=plan_change(self.config(),None,{'action':'toggle','tag':'web','enabled':False,'fallback':'backup'})
        self.refuse(p['config'],p['metadata'],{'action':'domain_route','enabled':True,'outbound':'independent-us'},'disabled_groups')

    def test_active_domain_route_blocks_normalize_to_preserve_original_rules(self):
        p=self.enable()
        self.refuse(p['config'],p['metadata'],{'action':'normalize'},'domain_route_active')

    def test_group_toggle_coexists_but_blocks_domain_removal_until_restored(self):
        original=self.config();p=self.enable(original)
        q=plan_change(p['config'],p['metadata'],{'action':'toggle','tag':'web','enabled':False,'fallback':'backup'})
        self.assertEqual(q['config']['routing']['rules'][2],p['config']['routing']['rules'][2])
        self.assertEqual(len(q['config']['routing']['rules']),len(p['config']['routing']['rules']))
        self.refuse(q['config'],q['metadata'],{'action':'domain_route','enabled':False},'disabled_groups')
        r=self.enable(q['config'],q['metadata'],outbound='backup')
        self.assertEqual(r['config']['routing']['rules'][2]['outboundTag'],'backup')
        s=plan_change(r['config'],r['metadata'],{'action':'toggle','tag':'web','enabled':True})
        t=plan_change(s['config'],s['metadata'],{'action':'domain_route','enabled':False})
        self.assertEqual(t['config'],original);self.assertEqual(t['metadata'],{'version':1,'disabled':{}})

    def test_rule_and_position_drift_rejected_by_every_action(self):
        for mutation in ['owned','old','position','duplicate','missing']:
            p=self.enable();rules=p['config']['routing']['rules']
            if mutation=='owned':rules[2]['domain'].append('domain:evil.invalid')
            elif mutation=='old':rules[3]['domain'].append('domain:other.invalid')
            elif mutation=='position':rules[2],rules[3]=rules[3],rules[2]
            elif mutation=='duplicate':rules.append(copy.deepcopy(rules[2]))
            else:rules.pop(2)
            for r in [{'action':'normalize'},{'action':'toggle','tag':'web','enabled':True},{'action':'domain_route','enabled':False}]:
                with self.subTest(mutation=mutation,action=r['action']):self.refuse(p['config'],p['metadata'],r,'metadata_drift')

    def test_target_configuration_drift_is_not_silently_accepted(self):
        p=self.enable();p['config']['outbounds'][-1]['settings']['id']='CHANGED_PRIVATE_TEST_VALUE'
        self.refuse(p['config'],p['metadata'],{'action':'domain_route','enabled':False},'metadata_drift')

    def test_orphan_marker_is_not_adopted_or_normalized(self):
        p=self.enable()
        for r in [{'action':'domain_route','enabled':True,'outbound':'independent-us'},{'action':'normalize'}]:
            self.refuse(p['config'],None,r,'metadata_drift')

    def test_ambiguous_restore_metadata_is_rejected(self):
        p=self.enable();p['metadata']['domain_routes']['other']={}
        self.refuse(p['config'],p['metadata'],{'action':'domain_route','enabled':False},'metadata_drift')

    def test_preexisting_target_before_later_protected_rule_is_refused(self):
        c=self.config();rules=c['routing']['rules'];rules[1],rules[2]=rules[2],rules[1]
        self.refuse(c,None,{'action':'domain_route','enabled':True,'outbound':'independent-us'},'unsafe_domain_position')

    def test_opaque_preceding_rule_prevents_claiming_safe_priority(self):
        for match in [{'domain':['geosite:openai']},{'domain':['regexp:.*']},{'network':'tcp,udp'},{'ip':['geoip:us']}]:
            c=self.config();c['routing']['rules'].insert(1,dict(type='field',outboundTag='backup',**match))
            self.refuse(c,None,{'action':'domain_route','enabled':True,'outbound':'independent-us'},'unsafe_domain_position')

    def test_unrelated_rule_before_later_probe_can_stay_at_its_index(self):
        c=self.config();c['routing']['rules'].insert(1,{'type':'field','domain':['domain:notchatgpt.com'],'outboundTag':'backup'})
        p=self.enable(c)
        self.assertEqual(p['config']['routing']['rules'][:3],c['routing']['rules'][:3])
        self.assertEqual(p['config']['routing']['rules'][3]['outboundTag'],'independent-us')

    def test_cf_api_inbound_is_protected_even_if_api_tag_uses_another_name(self):
        c=self.config();c['inbounds'].append({'tag':'cf-api'})
        c['routing']['rules'].insert(2,{'type':'field','inboundTag':['cf-api'],'outboundTag':'backup'})
        p=self.enable(c)
        self.assertEqual(p['config']['routing']['rules'][:3],c['routing']['rules'][:3])
        self.assertEqual(p['config']['routing']['rules'][3]['outboundTag'],'independent-us')

    def test_subdomain_and_parent_domain_before_probe_are_intersections(self):
        for domain in ['full:ab.chatgpt.com','domain:chatgpt.com','domain:com']:
            c=self.config();c['routing']['rules'].insert(1,{'type':'field','domain':[domain],'outboundTag':'backup'})
            self.refuse(c,None,{'action':'domain_route','enabled':True,'outbound':'independent-us'},'unsafe_domain_position')

    def test_empty_rule_list_can_enable_and_restore(self):
        c=self.config();c['routing']['rules']=[]
        p=self.enable(c)
        self.assertEqual(len(p['config']['routing']['rules']),1)
        q=plan_change(p['config'],p['metadata'],{'action':'domain_route','enabled':False})
        self.assertEqual(q['config'],c)

    def test_state_exports_only_safe_choices_and_no_private_target_settings(self):
        self.assertTrue(hasattr(policy,'chatgpt_route_state'),'缺少域名路由状态接口')
        c=self.config();state=policy.chatgpt_route_state(c,None)
        self.assertFalse(state['enabled']);self.assertIsNone(state['outbound']);self.assertEqual(state['rule_indices'],[])
        self.assertEqual({x['tag'] for x in state['outbounds']},{'proxy','backup','independent-us'})
        p=self.enable(c);state=policy.chatgpt_route_state(p['config'],p['metadata'])
        self.assertTrue(state['enabled']);self.assertEqual(state['outbound'],'independent-us');self.assertEqual(state['rule_indices'],[2])
        self.assertNotIn('PRIVATE_TEST_VALUE',json.dumps([state,p['metadata'],p['changes'],p['audit']]))


if __name__=='__main__':unittest.main()
