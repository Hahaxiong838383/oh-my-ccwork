import unittest
from utterance_association import associate
class AssociationTests(unittest.TestCase):
 def test_split_single_reply(self):
  x=associate([{'t':100,'text':'不要查天气'},{'t':550,'text':'我们聊小猫'}],['不要查天气','我们聊小猫'],[{'t':2300,'since_turn_ms':1750}],15000);self.assertEqual(x['errors'],[]);self.assertEqual(x['commit_to_body_ms'],1750)
 def test_slow_is_retained(self):
  x=associate([{'t':100,'text':'我们聊小猫'}],['我们聊小猫'],[{'t':5650,'since_turn_ms':5550}],15000);self.assertEqual(x['commit_to_body_ms'],5550);self.assertEqual(x['errors'],[])
 def test_missing_stays_failure(self):
  x=associate([{'t':100,'text':'我们聊小猫'}],['我们聊小猫'],[],15000);self.assertIn('body_count_0',x['errors'])
 def test_mismatched_input_stays_failure(self):
  x=associate([{'t':100,'text':'我们聊小狗'}],['我们聊小猫'],[{'t':1100,'since_turn_ms':1000}],15000);self.assertIn('commit_caption_mismatch',x['errors'])
 def test_two_replies_cannot_be_hidden(self):
  x=associate([{'t':100,'text':'不要查天气'},{'t':550,'text':'我们聊小猫'}],['不要查天气','我们聊小猫'],[{'t':500,'since_turn_ms':400},{'t':2300,'since_turn_ms':1750}],15000);self.assertIn('superseded_segment_produced_body',x['errors'])
if __name__=='__main__':unittest.main()
