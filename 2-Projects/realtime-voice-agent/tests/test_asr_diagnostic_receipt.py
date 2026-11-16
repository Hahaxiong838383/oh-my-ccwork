import copy, importlib.util, pathlib, unittest
P = pathlib.Path(__file__).parents[1] / 'scripts/asr_diagnostic_receipt.py'
spec = importlib.util.spec_from_file_location('receipt', P)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SN = 'BJP00326111699999901'
ROOM = 'sn-' + SN + '-123456'
TRACE = '11111111-1111-4111-8111-111111111111'

def line(msg, pid='321'):
    return {'MESSAGE': msg, '_PID': pid, '_SYSTEMD_UNIT': 'voice-worker-rust', '__REALTIME_TIMESTAMP': '123456000'}

def fixture():
    return {'device_sn': SN, 'trace_id': TRACE, 'room': ROOM, 'evidence_scope': 'isolated_sdk',
            'worker_runtime': {'pid':'321', 'unit':'voice-worker-rust', 'agent_name':'rust-worker', 'binary_sha256':'a'*64, 'source_sha':'b'*40}}, [
        line(f'INFO job accepted job_id=JOB123 room={ROOM} trace={TRACE}'),
        line(f'INFO asr_stream{{room={ROOM}}}: asr diagnostic connection summary request_id=req1 input_generation=gen1 stage=receive outcome=cancelled stats={{"written":{{"samples":3200}},"responses":1,"final_delivered":1}} queue={{"phase":"rtc","accepted":{{"samples":3200}}}}'),
        line(f'INFO asr final received room={ROOM} trace={TRACE} chars=7 phase=Rtc'),
        line(f'INFO job closed job_id=JOB123 room={ROOM} uptime_s=12'),
        line('INFO asr diagnostic input summary input_generation=gen1 stats={"phase":"rtc","accepted":{"samples":3200}}'),
    ]

class ReceiptTests(unittest.TestCase):
    def test_full_chain_has_identity_and_only_proves_coverage(self):
        binding, rows = fixture(); r = m.build_receipt(binding, rows)
        self.assertEqual(r['device_sn'], SN)
        self.assertEqual(r['coverage'], 'COVERED')
        self.assertEqual(r['question_final'], True)
        self.assertIsNone(r['physical_device_participated'])
        self.assertEqual(r['asr_root_cause_closed'], False)

    def test_no_summary_not_pass_even_if_final_exists(self):
        b, rows = fixture(); r = m.build_receipt(b, [rows[0], rows[2], rows[3]])
        self.assertEqual(r['coverage'], 'NOT_COVERED')

    def test_first_turn_summary_does_not_cover_question(self):
        b, rows = fixture(); rows[1]['MESSAGE'] = rows[1]['MESSAGE'].replace('"rtc"', '"ordered_or_initial"')
        rows[2]['MESSAGE'] = rows[2]['MESSAGE'].replace('phase=Rtc', 'phase=FirstTurn')
        r = m.build_receipt(b, rows)
        self.assertEqual(r['coverage'], 'NOT_COVERED'); self.assertFalse(r['question_final'])

    def test_covered_failure_is_not_reported_as_success(self):
        b, rows = fixture(); r = m.build_receipt(b, [rows[0], rows[1], rows[3], rows[4]])
        self.assertEqual(r['coverage'], 'COVERED'); self.assertFalse(r['question_final'])
        self.assertEqual(r['result'], 'NO_FINAL')

    def test_other_room_and_unkeyed_summary_cannot_fill_gap(self):
        b, rows = fixture(); rows[1]['MESSAGE'] = rows[1]['MESSAGE'].replace(ROOM, ROOM + '1')
        rows.append(line('INFO asr diagnostic connection summary request_id=req2 input_generation=gen2 stats={"final_delivered":1} queue={"phase":"rtc"}'))
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

    def test_same_room_other_pid_is_not_attributed(self):
        b, rows = fixture(); rows[1]['_PID'] = '999'
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

    def test_missing_or_mismatched_device_identity_rejected(self):
        for change in [{'device_sn': ''}, {'device_sn': SN + 'X'}, {'trace_id': ''}]:
            b, rows = fixture(); b.update(change)
            with self.assertRaises(ValueError): m.build_receipt(b, rows)

    def test_duplicate_binding_is_ambiguous(self):
        b, rows = fixture(); rows.append(line(rows[0]['MESSAGE'].replace('JOB123', 'JOB456')))
        with self.assertRaises(ValueError): m.build_receipt(b, rows)

    def test_journal_byte_arrays_and_ansi_are_supported(self):
        b, rows = fixture(); rows[1]['MESSAGE'] = list(('\x1b[32m' + rows[1]['MESSAGE'] + '\x1b[0m').encode())
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'COVERED')

    def test_broken_json_summary_does_not_pass(self):
        b, rows = fixture(); rows[1]['MESSAGE'] = rows[1]['MESSAGE'].replace('stats={', 'stats={BROKEN')
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

    def test_report_does_not_export_transcript(self):
        b, rows = fixture(); rows.append(line(f'INFO room={ROOM} stt final: private-child-utterance'))
        self.assertNotIn('private-child-utterance', str(m.build_receipt(b, rows)))

    def test_tail_only_sn_is_rejected_even_if_room_matches(self):
        b, rows = fixture(); b['device_sn'] = SN[-8:]; b['room'] = ROOM.replace(SN, SN[-8:])
        for row in rows: row['MESSAGE'] = row['MESSAGE'].replace(SN, SN[-8:])
        with self.assertRaises(ValueError): m.build_receipt(b, rows)

    def test_same_room_different_trace_or_job_is_ambiguous(self):
        b, rows = fixture(); rows.append(line(f'INFO job accepted room={ROOM} job_id=OTHER trace=another-trace'))
        with self.assertRaises(ValueError): m.build_receipt(b, rows)

    def test_missing_runtime_proof_cannot_be_covered(self):
        b, rows = fixture(); b.pop('worker_runtime', None)
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

    def test_runtime_proof_for_other_pid_cannot_be_covered(self):
        b, rows = fixture(); b['worker_runtime'] = {'pid':'999','unit':'voice-worker-rust','agent_name':'rust-worker','binary_sha256':'a'*64,'source_sha':'b'*40}
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

    def test_missing_input_summary_cannot_be_covered(self):
        b, rows = fixture(); rows = [r for r in rows if 'asr diagnostic input summary' not in r['MESSAGE']]
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

    def test_final_without_corresponding_diagnostic_delivery_is_not_covered(self):
        b, rows = fixture(); rows[1]['MESSAGE'] = rows[1]['MESSAGE'].replace('"final_delivered":1', '"final_delivered":0')
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

    def test_other_generation_input_summary_cannot_fill_gap(self):
        b, rows = fixture(); rows[4]['MESSAGE'] = rows[4]['MESSAGE'].replace('gen1', 'gen2')
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

    def test_duplicate_request_summary_is_ambiguous(self):
        b, rows = fixture(); rows.append(copy.deepcopy(rows[1]))
        self.assertEqual(m.build_receipt(b, rows)['coverage'], 'NOT_COVERED')

if __name__ == '__main__': unittest.main()
