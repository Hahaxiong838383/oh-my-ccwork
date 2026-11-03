"""Checks the acceptance probe's v380 consumer against literal wire examples.
The real Android controller is independently replayed by session38; this is not JVM proof.
"""
import unittest
from v380_consumer import V380Consumer


def ack(seq, stage, state, epoch=1):
    return {'src':'worker','trace_id':'trace-1','type':'listening.ack','payload':{
        'version':1,'request_id':f'trace-1:{seq}','command_seq':seq,
        'stage':stage,'state':state,'mode_epoch':epoch}}


class Consumption(unittest.TestCase):
    def test_completed_entry_old_ack_cannot_fake_asynchronous_terminal(self):
        c=V380Consumer('trace-1');c.command('enter',1)
        self.assertEqual(c.ack(ack(1,'received','entering')), 'local_ready')
        c.ack(ack(1,'completed','listening'))
        self.assertEqual(c.state,'listening')
        self.assertEqual(c.ack(ack(1,'completed','normal',2)), 'request_mismatch')
        self.assertEqual(c.state,'listening')
        c.disconnected();self.assertEqual(c.state,'normal');self.assertFalse(c.connected)

    def test_normal_exit_matches_real_pending_and_is_idempotent(self):
        c=V380Consumer('trace-1');c.command('exit',7)
        c.ack(ack(6,'completed','normal',2));self.assertEqual(c.state,'preparing')
        self.assertEqual(c.ack(ack(7,'completed','normal',2)),'exit_completed')
        self.assertTrue(c.connected)
        self.assertEqual(c.ack(ack(7,'completed','normal',2)),'request_mismatch')

    def test_query_during_pending_preserves_transition_and_paused_recovers(self):
        c=V380Consumer('trace-1');c.command('enter',1);c.query(2)
        c.ack(ack(2,'completed','normal',0));self.assertEqual(c.state,'preparing')
        c.ack(ack(2,'completed','paused',2));self.assertEqual(c.state,'paused')
        self.assertTrue(c.recovery)

    def test_rejected_is_not_failed_in_exact_v380_and_bad_sender_is_ignored(self):
        c=V380Consumer('trace-1');c.command('enter',1)
        self.assertEqual(c.ack(ack(1,'rejected','paused')),'stage_unknown')
        self.assertFalse(c.recovery)
        bad=ack(1,'completed','listening');bad['trace_id']='other';c.ack(bad)
        self.assertEqual(c.state,'preparing')
        bad=ack(1,'completed','listening');bad['src']='android';c.ack(bad)
        self.assertEqual(c.state,'preparing')
        c.ack(ack(1,'failed','paused'));self.assertTrue(c.recovery)

if __name__=='__main__':unittest.main()
