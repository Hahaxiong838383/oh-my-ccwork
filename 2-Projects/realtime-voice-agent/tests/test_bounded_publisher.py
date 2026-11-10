import importlib.util, pathlib, tempfile, unittest, json
spec=importlib.util.spec_from_file_location('publisher',pathlib.Path(__file__).parents[1]/'scripts/apply_hotwords.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PublisherTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();p.RUST_ENV=self.tmp.name+'/worker.env'
  pathlib.Path(p.RUST_ENV).write_text('LLM_FALLBACK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3\nLLM_FALLBACK_MODEL=doubao-seed-2.0-mini\nLLM_FALLBACK_API_KEY=volc-aaaaaaaaaaaaaaaaaaaa\nLLM_FALLBACK_THINKING=disabled\nLLM_FALLBACK_TRIGGER_MS=2000\nLLM_FALLBACK_DEADLINE_MS=6000\nLLM_FALLBACK_DEEPSEEK_API_KEY=deepseek-bbbbbbbbbbbbbbbb\n')
  p.recent_activity=lambda:0;p.stop_drain_start=lambda:(True,'ok');p.race_proc_values=lambda:p._race_values(p.read_lines(p.RUST_ENV));p.time.sleep=lambda _:None;p.run=lambda *a,**k:None;p.health=lambda _: (True,'recovered')
 def tearDown(self):self.tmp.cleanup()
 def values(self):return dict(x.split('=',1)for x in p.read_lines(p.RUST_ENV)if '='in x)
 def test_switch_and_roundtrip_keeps_each_key(self):
  r=p.do_race_set({'values':{'LLM_FALLBACK_PROVIDER':'deepseek','LLM_FALLBACK_ENABLED':'1'}})
  self.assertTrue(r['ok'],r);self.assertEqual(self.values()['LLM_FALLBACK_API_KEY'],'deepseek-bbbbbbbbbbbbbbbb')
  self.assertNotIn('bbbbbb',json.dumps(r));self.assertEqual(self.values()['LLM_FALLBACK_MODEL'],'deepseek-v4-flash')
  r=p.do_race_set({'values':{'LLM_FALLBACK_PROVIDER':'volc_plan'}});self.assertTrue(r['ok'],r)
  self.assertEqual(self.values()['LLM_FALLBACK_API_KEY'],'volc-aaaaaaaaaaaaaaaaaaaa')
 def test_missing_profile_does_not_reuse_other_key(self):
  before=pathlib.Path(p.RUST_ENV).read_bytes();r=p.do_race_set({'values':{'LLM_FALLBACK_PROVIDER':'volc_coding'}})
  self.assertFalse(r['ok']);self.assertEqual(pathlib.Path(p.RUST_ENV).read_bytes(),before)
 def test_partial_budget_checks_merged_state(self):
  before=pathlib.Path(p.RUST_ENV).read_bytes();r=p.do_race_set({'values':{'LLM_FALLBACK_TRIGGER_MS':'5000'}})
  self.assertFalse(r['ok']);self.assertEqual(pathlib.Path(p.RUST_ENV).read_bytes(),before)
 def test_disable_preserves_profile(self):
  r=p.do_race_set({'values':{'LLM_FALLBACK_ENABLED':'0'}});self.assertTrue(r['ok'],r);self.assertEqual(self.values()['LLM_FALLBACK_API_KEY'],'volc-aaaaaaaaaaaaaaaaaaaa')
 def test_restart_failure_restores_complete_file(self):
  before=pathlib.Path(p.RUST_ENV).read_bytes();p.stop_drain_start=lambda:(False,'test failure')
  r=p.do_race_set({'values':{'LLM_FALLBACK_PROVIDER':'deepseek'}});self.assertTrue(r.get('rolled_back'),r);self.assertEqual(pathlib.Path(p.RUST_ENV).read_bytes(),before)
 def test_mismatched_provider_url_rejected(self):
  self.assertFalse(p.do_race_set({'values':{'LLM_FALLBACK_PROVIDER':'deepseek','LLM_FALLBACK_BASE_URL':'https://ark.cn-beijing.volces.com/api/plan/v3'}})['ok'])
 def test_bench_never_sends_active_key_to_different_base(self):
  p._bench_call=lambda *a,**k: self.fail('cross-provider request made')
  r=p.do_race_bench({'models':['deepseek-v4-flash'],'base':'https://api.deepseek.com/v1'});self.assertFalse(r['ok'])
 def test_config_write_lock_blocks_concurrent_mutations(self):
  import fcntl,io,contextlib,sys
  before=pathlib.Path(p.RUST_ENV).read_bytes()
  with open(p.RUST_ENV+'.config.lock','a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   for action in ['race_set','voice_set','apply']:
    old=sys.stdin;sys.stdin=io.StringIO(json.dumps({'action':action,'values':{'LLM_FALLBACK_ENABLED':'0'}}));out=io.StringIO()
    try:
     with contextlib.redirect_stdout(out):p.main()
    finally:sys.stdin=old
    self.assertEqual(json.loads(out.getvalue()).get('error'),'配置发布正在进行，请稍后重试')
  self.assertEqual(pathlib.Path(p.RUST_ENV).read_bytes(),before)
if __name__=='__main__' :unittest.main()
