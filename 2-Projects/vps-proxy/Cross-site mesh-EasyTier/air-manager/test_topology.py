import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import easytier_topology as t
spec=importlib.util.spec_from_file_location('lease',Path(__file__).with_name('nas-bootstrap-lease.py'))
lease=importlib.util.module_from_spec(spec);spec.loader.exec_module(lease)

class TopologyTests(unittest.TestCase):
 def test_allowlist(self):
  raw=json.dumps([{'url':{'url':t.ENDPOINTS[0][2]},'status':0,'secret':'NOT_TO_EXPORT'},{'url':{'url':'tcp://unknown.example:1'},'status':0}])
  self.assertEqual(t.parse_connectors(raw),{t.ENDPOINTS[0][2]:'connected'})
 def test_unknown_status(self):
  self.assertEqual(t.parse_connectors(json.dumps([{'url':{'url':t.ENDPOINTS[0][2]},'status':999}]))[t.ENDPOINTS[0][2]],'unknown')
 def test_malformed_schema(self):
  with self.assertRaises(ValueError):t.parse_connectors('{}')
 def test_collect_dns_and_connection(self):
  def runner(a,timeout=5):
   if a[0]==t.CLI:return 0,json.dumps([{'url':{'url':t.ENDPOINTS[0][2]},'status':0}])
   return 0, 'alias.example.\n120.244.92.119\n' if a[-1]=='A' else '2409:8a00:8473:5740::1\n'
  x=t.collect(runner)
  self.assertEqual(x['endpoints'][0]['resolved'],['120.244.92.119'])
  self.assertEqual(x['endpoints'][0]['state'],'connected')
  self.assertEqual(x['endpoints'][1]['state'],'not_observed')
 def test_failures_do_not_claim_connected(self):
  x=t.collect(lambda *a,**k:(-1,''))
  self.assertTrue(all(r['state']=='not_observed' for r in x['endpoints']))
  self.assertEqual(x['endpoints'][0]['dns_status'],'unresolved')
 def test_dns_family_filter(self):
  x=t.collect(lambda a,**k:(0,'[]') if a[0]==t.CLI else (0,'127.0.0.1\n::1\n'))
  self.assertEqual(x['endpoints'][0]['resolved'],['127.0.0.1'])
  self.assertEqual(x['endpoints'][1]['resolved'],['::1'])
 def test_no_node_config_commands(self):
  commands=[]
  def runner(a,**k):commands.append(a);return 0,'[]'
  t.collect(runner)
  self.assertTrue(all('node' not in a for a in commands))
  self.assertEqual(len(commands),3)

class LeaseTests(unittest.TestCase):
 def existing(self,**kw):
  d={'NewInternalClient':'192.168.1.115','NewInternalPort':'21110','NewPortMappingDescription':'EasyTier-Lucky-NAS2','NewEnabled':'1','NewLeaseDuration':'604000'};d.update(kw);return d
 def test_valid_no_write(self):
  with patch.object(lease,'call',return_value=self.existing()) as call:
   self.assertTrue(lease.ensure()['ok']);self.assertEqual(call.call_count,1)
 def test_wrong_target_refuse(self):
  with patch.object(lease,'call',return_value=self.existing(NewInternalClient='192.168.1.2')) as call:
   self.assertFalse(lease.ensure()['ok']);self.assertEqual(call.call_count,1)
 def test_other_owner_refuse(self):
  with patch.object(lease,'call',return_value=self.existing(NewPortMappingDescription='other')) as call:
   self.assertFalse(lease.ensure()['ok']);self.assertEqual(call.call_count,1)
 def test_absent_add_exact_mapping(self):
  with patch.object(lease,'call',side_effect=[{'errorCode':'714'},{},self.existing()]) as call:
   self.assertTrue(lease.ensure()['ok']);self.assertEqual(call.call_args_list[1].args[0],'AddPortMapping')
   self.assertEqual(call.call_args_list[1].args[1]['NewExternalPort'],21110)
 def test_short_lease_renew(self):
  with patch.object(lease,'call',side_effect=[self.existing(NewLeaseDuration='100'),{},self.existing()]):
   self.assertEqual(lease.ensure()['code'],'mapping_renewed')
 def test_failed_add_not_success(self):
  with patch.object(lease,'call',side_effect=[{'errorCode':'714'},{'errorCode':'718'}]):
   self.assertFalse(lease.ensure()['ok'])
 def test_disabled_reenable(self):
  with patch.object(lease,'call',side_effect=[self.existing(NewEnabled='0'),{},self.existing()]):
   self.assertTrue(lease.ensure()['ok'])
 def test_gateway_failure_no_add(self):
  with patch.object(lease,'call',return_value={'errorCode':'501'}) as call:
   self.assertFalse(lease.ensure()['ok']);self.assertEqual(call.call_count,1)

if __name__=='__main__':unittest.main(verbosity=2)
