import pathlib, subprocess, tempfile, unittest

SOURCE=pathlib.Path(__file__).resolve().parents[1]/'state.sh'
BOOT='5221cafe-ca9c-4f1d-ad1d-4bf399d87d7c'
class SourceTest(unittest.TestCase):
    def phase(self, ready, log):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d); (p/'ready').write_text(ready); (p/'log').write_text(log)
            return subprocess.check_output(['sh','-c','. "$1"; status_phase "$2" "$3" "$4"','sh',str(SOURCE),BOOT,str(p/'ready'),str(p/'log')],text=True).strip()
    def test_old_boot_and_misleading_success_log(self):
        self.assertEqual(self.phase('old-boot',f'now boot={BOOT} uptime=45 dns_takeover_ready\n'), 'connecting')
    def test_true_gate(self):
        self.assertEqual(self.phase(BOOT+'\n',''), 'ready')
    def test_progress_and_retry(self):
        self.assertEqual(self.phase('',f'now boot={BOOT} uptime=33 dns_queries_verified\n'), 'cache')
        self.assertEqual(self.phase('',f'now boot={BOOT} uptime=33 retry_later reason=failed\n'), 'retry')
        self.assertEqual(self.phase('',f'now boot=old uptime=33 dns_queries_verified\n'), 'connecting')
    def test_home_gate(self):
        for raw,expected in [('mResumedActivity: ActivityRecord{x u0 com.dangbei.tvlauncher/.Main t1}','true'),
                             ('mResumedActivity: ActivityRecord{x u0 com.player.diyp2020/.Player t1}','false'),
                             ('mResumedActivity: ActivityRecord{x u10 com.dangbei.tvlauncher/.Main t1}','false'),
                             ('error: timeout','false')]:
            self.assertEqual(subprocess.check_output(['sh','-c','. "$1"; status_home','sh',str(SOURCE)],input=raw,text=True).strip(),expected)
    def test_ambiguous_foreground(self):
        raw='mResumedActivity: x u0 com.dangbei.tvlauncher/.Main\nmResumedActivity: x u0 com.player.diyp2020/.Player\n'
        self.assertEqual(subprocess.check_output(['sh','-c','. "$1"; status_home','sh',str(SOURCE)],input=raw,text=True).strip(),'false')
    def test_observed_rom_resume_event(self):
        for raw,expected in [('I/wm_set_resumed_activity( 1262): [0,com.dangbei.tvlauncher/com.dangbei.launcher.ui.main.MainActivity,minimalResumeActivityLocked]','true'),
                             ('I/wm_set_resumed_activity( 1262): [0,com.player.diyp2020/com.player.activity.PlayerActivity,minimalResumeActivityLocked]','false'),
                             ('I/wm_set_resumed_activity( 1262): [0,com.dangbei.tvlauncher.fake/.Main,minimalResumeActivityLocked]','false')]:
            self.assertEqual(subprocess.check_output(['sh','-c','. "$1"; status_event_home "$2"','sh',str(SOURCE),raw],text=True).strip(),expected)
if __name__=='__main__': unittest.main()
