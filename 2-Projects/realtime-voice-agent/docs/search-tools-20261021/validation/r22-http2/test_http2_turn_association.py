import unittest
from http2_turn_association import associate_body
class Association(unittest.TestCase):
 def body(self,turn,t,since):return {'turn_id':str(turn),'t':t,'since_turn_ms':since}
 def test_prior_query_response_does_not_become_current_answer(self):
  r=associate_body(1000,10000,[self.body(1,1200,1200),self.body(2,2000,1000)],set())
  self.assertEqual([x['turn_id']for x in r['matched']],['2']);self.assertEqual(r['other'][0]['reason'],'started_before_target_commit')
 def test_slow_start_and_slow_body_are_not_excluded(self):
  r=associate_body(1000,20000,[self.body(2,15000,9000)],set())
  self.assertFalse(r['missing_or_ambiguous']);self.assertEqual(r['matched'][0]['commit_to_body_ms'],14000)
 def test_unanswered_input_is_missing_not_success(self):
  r=associate_body(1000,10000,[self.body(1,1500,1500),self.body(9,2200,1200)],{'9'})
  self.assertTrue(r['missing_or_ambiguous']);self.assertEqual(r['matched'],[])
 def test_two_possible_answers_cannot_pick_faster_one(self):
  r=associate_body(1000,10000,[self.body(2,2000,1000),self.body(3,7000,6000)],set())
  self.assertTrue(r['missing_or_ambiguous']);self.assertEqual(len(r['matched']),2)
 def test_background_result_within_target_interval_is_not_chat(self):
  r=associate_body(1000,10000,[self.body(9,1300,200),self.body(2,2000,1000)],{'9'})
  self.assertEqual([x['turn_id']for x in r['matched']],['2'])
 def test_next_input_reply_cannot_fill_missing_body(self):
  r=associate_body(1000,3000,[self.body(3,4000,1000)],set())
  self.assertTrue(r['missing_or_ambiguous']);self.assertEqual(r['other'][0]['reason'],'belongs_to_next_commit')
 def test_integer_millisecond_clock_rounding_only(self):
  self.assertFalse(associate_body(1000,3000,[self.body(2,1999.7,1000)],set())['missing_or_ambiguous'])
  self.assertTrue(associate_body(1000,3000,[self.body(2,1998,1000)],set())['missing_or_ambiguous'])
if __name__=='__main__':unittest.main()
