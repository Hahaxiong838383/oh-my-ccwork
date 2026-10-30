#!/usr/bin/env python3
"""Synthetic release tests: no production credentials or device operations."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import amend_rack_dualstack as amendment
import generate
from test_runtime import source


class Amendment(unittest.TestCase):
    def setUp(self):
        initial = source()
        next(o for o in initial['outbounds'] if o['tag'] == 'hy2')['server'] = '192.0.2.10'
        self.files, _, _ = generate.build(initial, {'youtube': 10076, 'smarttube': 10082})
        self.files['main-config.json']['dns']['optimistic'] = dict(enabled=True, timeout='5m')
        self.files['main-config.json']['experimental']['cache_file'] = dict(enabled=True, path='/tmp/synthetic-cache.db', store_dns=True)
        self.args = dict(old_ipv4='192.0.2.10', ipv4='198.51.100.10', ipv6='2001:db8::10', port=24443,
                         sni='example.org', selected_video='yt-zgo-reality', selected_dns='dns-zgo-reality')

    def apply(self):
        return amendment.amend(*(self.files[n] for n in ('main-config.json','workers/rack/config.json','guard-config.json','guard-observe.json')), **self.args)

    def test_only_intended_changes(self):
        before = copy.deepcopy(self.files)
        main, worker, guard, observe = self.apply()
        self.assertEqual(before, self.files)
        old = before['main-config.json']
        obs = {o['tag']: o for o in main['outbounds']}
        for o in old['outbounds']:
            if o['tag'] not in ('reality','yt-rack-reality','dns-rack-reality','hy2','youtube-video','dns-uplink'):
                self.assertEqual(o, obs[o['tag']])
        self.assertEqual(main['dns'], old['dns'])
        self.assertEqual(main['experimental'], old['experimental'])
        self.assertEqual(main['inbounds'][:-2], old['inbounds'])
        self.assertEqual([r for r in main['route']['rules'] if r.get('inbound') not in [['probe-'+amendment.V6_VIDEO],['probe-'+amendment.V6_DNS]]], old['route']['rules'])
        for tag in ('reality','yt-rack-reality','dns-rack-reality'):
            original=next(o for o in old['outbounds'] if o['tag']==tag)
            restored=copy.deepcopy(obs[tag]);restored['server']=original['server'];restored['server_port']=original['server_port'];restored['tls']['server_name']=original['tls']['server_name']
            self.assertEqual(restored,original)
        self.assertEqual(obs['youtube-video']['default'],'yt-zgo-reality')
        self.assertEqual(obs['dns-uplink']['default'],'dns-zgo-reality')
        self.assertEqual(obs[amendment.V6_VIDEO]['server'],'2001:db8::10')
        self.assertEqual([c['tag'] for c in guard['candidates']],obs['youtube-video']['outbounds'])
        self.assertEqual([c['tag'] for c in observe['dns']['candidates']],obs['dns-uplink']['outbounds'])
        self.assertEqual([c for c in guard['candidates'] if c.get('worker')], [c for c in before['guard-config.json']['candidates'] if c.get('worker')])
        self.assertEqual(worker['outbounds'][0]['server'],'198.51.100.10')

    def test_refuse_drift_or_port_conflict(self):
        self.files['main-config.json']['inbounds'].append(dict(listen_port=19105))
        with self.assertRaises(AssertionError): self.apply()
        self.files['main-config.json']['inbounds'].pop()
        self.files['guard-config.json']['candidates'].reverse()
        with self.assertRaises(AssertionError): self.apply()

    def test_real_singbox_config_check(self):
        binary=Path(os.environ.get('TASK_SING_BOX','/tmp/video-proxy/sing-box-1.14.3-linux-amd64/sing-box'))
        self.assertTrue(binary.is_file(), 'required pre-existing sing-box missing')
        main,worker,_,_=self.apply()
        with tempfile.TemporaryDirectory(prefix='rack-dualstack-check-') as d:
            for name,c in [('main',main),('worker',worker)]:
                p=Path(d)/(name+'.json');p.write_text(json.dumps(c));p.chmod(0o600)
                result=subprocess.run([str(binary),'check','-c',str(p)],capture_output=True)
                self.assertEqual(result.returncode,0,'synthetic '+name+' rejected by actual sing-box')


if __name__=='__main__': unittest.main()
