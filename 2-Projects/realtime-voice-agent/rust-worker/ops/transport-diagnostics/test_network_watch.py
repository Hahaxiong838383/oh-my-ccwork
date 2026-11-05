import unittest
import socket
import struct
import json
import network_watch as watch


class MetadataTests(unittest.TestCase):
    def test_packet_parser_keeps_tcp_options_but_excludes_payload(self):
        options=bytes.fromhex('080a0000007b000001c80101')
        ip=bytearray(20);ip[0]=0x45;ip[9]=6
        ip[12:16]=socket.inet_aton('192.0.2.1');ip[16:20]=socket.inet_aton('192.0.2.2')
        tcp=bytearray(20);struct.pack_into('!HHII',tcp,0,443,12345,100,200);tcp[12]=0x80;tcp[13]=16
        payload=b'SECRET_AUDIO_OR_AUTH';struct.pack_into('!H',ip,2,len(ip)+len(tcp)+len(options)+len(payload))
        packet=bytes(12)+b'\x08\x00'+ip+tcp+options+payload
        event=watch.parse_packet(packet,'ens17',0,1,{'192.0.2.1'})
        self.assertEqual(event['tcp_options'],{'tsval':123,'tsecr':456})
        self.assertEqual(event['data_len'],len(payload));self.assertNotIn('SECRET',json.dumps(event))
        self.assertIsNone(watch.parse_packet(packet[:55],'ens17',0,1,{'192.0.2.1'}))

    def test_sack_timestamp_and_scale_are_numeric_metadata_only(self):
        raw = bytes.fromhex('030307010402050a00000064000000c8080a0000007b000001c800')
        self.assertEqual(watch.tcp_options(raw), {
            'window_scale': 7, 'sack_permitted': True,
            'sack_blocks': [[100, 200]], 'tsval': 123, 'tsecr': 456,
        })

    def test_unknown_options_and_payload_never_leak(self):
        self.assertEqual(watch.tcp_options(bytes([99, 6])+b'ABCD'+b'\0SECRET'), {})

    def test_truncated_or_invalid_options_are_marked_without_raw_bytes(self):
        for raw in [b'\x05', b'\x05\x0a\x01', b'\x08\x00']:
            self.assertEqual(watch.tcp_options(raw), {'options_malformed': True})

    def test_statistics_accumulate_kernel_reset_on_read_counters(self):
        totals = {}
        watch.add_packet_statistics(totals, 10, 2)
        watch.add_packet_statistics(totals, 5, 0)
        self.assertEqual(totals, {'capture_packets': 15, 'capture_kernel_drops': 2, 'capture_stat_reads': 2})


if __name__ == '__main__':
    unittest.main()
