"""Offline prepare guard regression; synthetic files and no real Xray command."""
import contextlib
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import air_ops
import controller

class PrepareGuardTests(unittest.TestCase):
    def test_prepare_hashes_exact_candidate_with_both_guard_algorithms(self):
        with tempfile.TemporaryDirectory() as directory:
            home=pathlib.Path(directory);xray=home/'xray';xray.mkdir()
            config=xray/'config.json';runtime=xray/'company-lisa-failover'
            config.write_text(json.dumps({'inbounds':[], 'outbounds':[
                {'tag':'admin-LISA-DMIT-11443','protocol':'blackhole'},
                {'tag':'admin-LISA-ZGO-12443','protocol':'blackhole'}],
                'routing':{'rules':[{'domain':['domain:fixture.invalid'],'outboundTag':'admin-LISA-DMIT-11443'}]}}))
            (home/'.mycc-secrets.env').write_text('COMPANY_RELAY_AIR_PASS=synthetic-unused-fixture\n')
            original=config.read_bytes();output=io.StringIO()
            with patch.multiple(air_ops,HOME=home,CONFIG=config,RUNTIME=runtime,
                PLIST=home/'controller.plist',TUNNEL_PLIST=home/'tunnel.plist'), \
                patch.object(air_ops,'run',return_value='') as run,contextlib.redirect_stdout(output):
                air_ops.prepare()
            stage=pathlib.Path(json.loads(output.getvalue())['stage'])
            raw=(stage/'candidate.json').read_bytes();cfg=json.loads((stage/'controller.json').read_text())
            self.assertEqual(cfg['guard_config_path'],str(config))
            self.assertEqual(cfg['guard_config_sha256'],air_ops.sha(raw))
            self.assertEqual(cfg.get('guard_config_semantic_sha256'),controller.canonical_config_sha256(raw))
            reformatted=json.dumps(json.loads(raw),sort_keys=True,separators=(',',':')).encode()
            self.assertNotEqual(air_ops.sha(reformatted),cfg['guard_config_sha256'])
            self.assertEqual(controller.canonical_config_sha256(reformatted),cfg['guard_config_semantic_sha256'])
            self.assertEqual(config.read_bytes(),original);self.assertFalse(runtime.exists())
            run.assert_called_once_with([str(xray/'xray'),'run','-test','-c',str(stage/'candidate.json')])
            manifest=json.loads((stage/'manifest.json').read_text())
            self.assertEqual(manifest['code_sha256']['controller.json'],air_ops.sha((stage/'controller.json').read_bytes()))

if __name__=='__main__': unittest.main()
