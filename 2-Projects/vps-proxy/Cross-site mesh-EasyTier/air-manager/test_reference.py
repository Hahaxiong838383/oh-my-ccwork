import json
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch,MagicMock
import easytier_reference as r

CAT='''ET_NODES=(
 "mini|mini-pub|10.10.10.11|macos-aarch64|secret:PRIVATE_TEST"
 "air|__LOCAL__|10.10.10.31|macos-aarch64|ask"
 "sleeping|user@192.168.1.77|10.10.10.24|linux|ask"
)
'''
class Reference(unittest.TestCase):
 def test_no_execute_or_credential_export(self):
  result=r.parse_catalog(CAT)
  self.assertEqual(len(result),3);self.assertNotIn('PRIVATE_TEST',json.dumps(result));self.assertNotIn('secret',json.dumps(result))
 def test_invalid_catalog(self):
  with self.assertRaises(ValueError):r.parse_catalog('not a catalog')
 def test_ip_scope(self):
  self.assertIsNone(r.mesh_ip('8.8.8.8'));self.assertIsNone(r.mesh_ip('garbage'));self.assertEqual(r.mesh_ip('10.10.10.12/24'),'10.10.10.12')
 def test_route_projection(self):
  a=r.route_map(json.dumps([{'ipv4':'10.10.10.11/24','proxy_cidrs':'10.10.61.0/24 garbage','secret':'DO_NOT_EXPORT'}]))
  self.assertEqual(a,{'10.10.10.11':['10.10.61.0/24']})
 def runner(self,args,**kwargs):
  if args[0].endswith('ssh'):
   return 0,'hostname 10.10.10.11\nuser demo\nport 22\n' if args[-1]=='mini-mesh' else 'hostname missing\nuser demo\n'
  return 0,json.dumps([{'ipv4':'10.10.10.11/24','proxy_cidrs':'10.10.61.0/24'}])
 def peers(self):
  return [{'ipv4':'10.10.10.31','hostname':'air','cost':'Local'},{'ipv4':'10.10.10.11','hostname':'mini','cost':'p2p','lat_ms':'12','tunnel_proto':'tcp'},{'ipv4':'10.10.10.14','hostname':'new-device','cost':'relay(2)','lat_ms':'20','tunnel_proto':''}]
 def collect(self,previous=None,peers=None):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d,'common.sh');path.write_text(CAT)
   collector=r.ReferenceCollector(path,service_probe=lambda svc:{'ok':True,'code':'http_response','http_status':200,'ms':1})
   self.probed=[]
   def probe(ip):self.probed.append(ip);return {'ip':ip,'ok':True,'tcp':True,'ms':2,'code':'ssh_response'}
   return collector.collect(self.runner,peers if peers is not None else self.peers(),[],{'physical_ip':'192.168.1.128'},previous or {},probe)
 def test_missing_registry_node_preserved(self):
  data=self.collect();node=next(x for x in data['devices'] if x['name']=='sleeping')
  self.assertFalse(node['observed']);self.assertIsNone(node['probe']);self.assertIsNone(node['last_seen']);self.assertNotIn('10.10.10.24',self.probed)
 def test_dynamic_peer_added(self):
  d=self.collect();node=next(x for x in d['devices'] if x['name']=='new-device');self.assertTrue(node['discovered']);self.assertTrue(node['observed'])
 def test_discovered_peer_retained_after_loss(self):
  before=self.collect();after=self.collect(before,[]);node=next(x for x in after['devices'] if x['name']=='new-device');self.assertFalse(node['observed']);self.assertEqual(node['last_seen'],next(x for x in before['devices'] if x['name']=='new-device')['last_seen'])
 def test_local_not_probed(self):
  self.collect();self.assertNotIn('10.10.10.31',self.probed)
 def test_ip_change_invalidates_alias(self):
  p=self.peers();p[1]['ipv4']='10.10.10.19';d=self.collect(peers=p);node=next(x for x in d['devices'] if x['name']=='mini');self.assertEqual(node['ip'],'10.10.10.19');self.assertIsNone(node['ssh_command'])
 def test_service_targets_fixed(self):
  d=self.collect();self.assertEqual(len(d['services']),4);self.assertEqual(d['services'][0]['url'],'http://10.10.61.18:5000/')
 def test_known_alias_only(self):
  d=self.collect();node=next(x for x in d['devices'] if x['name']=='mini');self.assertEqual(node['ssh_command'],'ssh mini-mesh')
 def test_catalog_unavailable_not_silently_complete(self):
  collector=r.ReferenceCollector('/does-not-exist',service_probe=lambda _: {'ok':False})
  d=collector.collect(self.runner,[],[],{}, {},lambda _:None);self.assertTrue(d['catalog_error'])
 def test_registry_cache(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d,'catalog');p.write_text(CAT);c=r.ReferenceCollector(p);calls=[]
   def runner(a,**k):calls.append(a);return self.runner(a,**k)
   c.registry(runner);n=len(calls);c.registry(runner);self.assertEqual(len(calls),n)
 def test_certificate_not_bypassed(self):
  with patch.object(r.http.client,'HTTPSConnection') as conn:
   conn.return_value.request.side_effect=ssl.SSLCertVerificationError('self signed')
   p=r.probe_service(r.SERVICES[1]);self.assertFalse(p['ok']);self.assertTrue(p['transport_ok']);self.assertEqual(p['code'],'certificate_error')
   self.assertTrue(conn.call_args.kwargs['context'].check_hostname)
 def test_timeout_distinct(self):
  with patch.object(r.http.client,'HTTPConnection') as conn:
   conn.return_value.request.side_effect=TimeoutError()
   self.assertEqual(r.probe_service(r.SERVICES[0])['code'],'timeout')
 def test_auth_response_reachable(self):
  with patch.object(r.http.client,'HTTPConnection') as conn:
   conn.return_value.getresponse.return_value.status=401
   p=r.probe_service(r.SERVICES[0]);self.assertTrue(p['ok']);self.assertEqual(p['http_status'],401)
 def test_no_redirect_following(self):
  with patch.object(r.http.client,'HTTPConnection') as conn:
   conn.return_value.getresponse.return_value.status=302
   r.probe_service(r.SERVICES[0]);self.assertEqual(conn.return_value.request.call_count,1)

if __name__=='__main__':unittest.main(verbosity=2)
