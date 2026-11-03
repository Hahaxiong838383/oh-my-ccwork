import hashlib
import unittest
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from prepare_hotword_snapshot import prepare


def sha(b): return hashlib.sha256(b).hexdigest()
def snapshot():
    kinds={}
    for kind, key, words in [('asr','VOLC_ASR_HOTWORDS',['补勤卡','补签卡','小可','暂停']),
                             ('device_asr','P003_DEVICE_ASR_HOTWORDS',['调亮'])]:
        kinds[kind]={'env_key':key,'live':words,'live_in_sync':True,'draft':None,
                     'published':{'status':'published','version':2,'id':7,'words':words}}
    return {'channel_ok':True,'kinds':kinds}


class Snapshot(unittest.TestCase):
    def test_cli_stages_private_output_without_mutating_input_or_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = 'SECRET=synthetic-private\nVOLC_ASR_HOTWORDS=小可,暂停\nP003_DEVICE_ASR_HOTWORDS=调亮\n'.encode()
            (root/'old.env').write_bytes(old)
            (root/'snapshot.json').write_text(json.dumps(snapshot()))
            command = [sys.executable, str(Path(__file__).with_name('prepare_hotword_snapshot.py')),
                       '--snapshot', str(root/'snapshot.json'), '--env-file', str(root/'old.env'),
                       '--expected-env-sha', sha(old), '--output', str(root/'new.env'),
                       '--receipt', str(root/'receipt.json')]
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(run.stdout, '')
            self.assertEqual((root/'old.env').read_bytes(), old)
            self.assertEqual((root/'new.env').stat().st_mode & 0o777, 0o600)
            self.assertNotIn('synthetic-private', (root/'receipt.json').read_text())
            before = (root/'new.env').read_bytes()
            again = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(again.returncode, 0)
            self.assertEqual((root/'new.env').read_bytes(), before)

    def test_only_published_terms_change_and_other_bytes_stay_exact(self):
        old=b'# private\r\nSECRET=synthetic-private\r\nVOLC_ASR_NONSTREAM_ENABLED=0\r\nVOLC_ASR_HOTWORDS="'+ '小可,暂停'.encode()+b'"\r\nP003_DEVICE_ASR_HOTWORDS='+ '调亮'.encode()+b'\r\n'
        new,r=prepare(snapshot(),old,sha(old))
        self.assertEqual(new,old.replace(('"小可,暂停"').encode(),'补勤卡,补签卡,小可,暂停'.encode()))
        self.assertEqual(r['changed_keys'],['VOLC_ASR_HOTWORDS'])
        self.assertNotIn('synthetic-private',str(r))
        self.assertEqual(r['after_sha256'],sha(new))

    def test_stale_file_duplicate_key_and_nonpublished_drift_fail_closed(self):
        old='VOLC_ASR_HOTWORDS=小可,暂停\nP003_DEVICE_ASR_HOTWORDS=调亮\n'.encode()
        with self.assertRaises(ValueError):prepare(snapshot(),old,'0'*64)
        dup=old+b'VOLC_ASR_HOTWORDS=wrong\n'
        with self.assertRaises(ValueError):prepare(snapshot(),dup,sha(dup))
        for field,value in [('live_in_sync',False),('live',['other']),('draft',{'words':['parallel']})]:
            s=snapshot();s['kinds']['asr'][field]=value
            with self.assertRaises(ValueError):prepare(s,old,sha(old))
        s=snapshot();s['kinds']['asr']['published']['status']='draft'
        with self.assertRaises(ValueError):prepare(s,old,sha(old))

    def test_other_pool_hotword_drift_and_arbitrary_additions_are_not_overwritten(self):
        for old in ['VOLC_ASR_HOTWORDS=other\nP003_DEVICE_ASR_HOTWORDS=调亮\n',
                    'VOLC_ASR_HOTWORDS=小可,暂停\nP003_DEVICE_ASR_HOTWORDS=other\n']:
            b=old.encode()
            with self.assertRaises(ValueError):prepare(snapshot(),b,sha(b))
        b='VOLC_ASR_HOTWORDS=小可,暂停\nP003_DEVICE_ASR_HOTWORDS=调亮\n'.encode()
        s=snapshot();s['kinds']['asr']['live'].append('错字')
        with self.assertRaises(ValueError):prepare(s,b,sha(b))

if __name__=='__main__': unittest.main()
