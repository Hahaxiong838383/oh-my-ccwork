import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).parents[1] / 'scripts/asr_diagnostic_env.py'
spec = importlib.util.spec_from_file_location('diagnostic_env', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SNS = ['BJP00326111699999901', 'BJP00326111699999902', 'BJP00326111699999903']
ALLOW = b'P003_ASR_DIAGNOSTICS_SN_ALLOW'
UNTIL = b'P003_ASR_DIAGNOSTICS_UNTIL_MS'


class DiagnosticEnvTests(unittest.TestCase):
    def test_add_and_rollback_missing_keys(self):
        original = b'# retained\nLLM_KEY=example-only\nOTHER=unchanged\n'
        patched, state = m.enable(original, SNS, 2000, now_ms=1000)
        self.assertTrue(patched.startswith(original))
        self.assertEqual(m.restore(patched, state), original)
        self.assertNotIn('example-only', str(state))

    def test_restore_existing_assignments_and_crlf(self):
        original = b'# retained\r\n' + ALLOW + b'="BJP00326111699999904"\r\nOTHER=yes\r\n' + UNTIL + b'=123\r\n'
        patched, state = m.enable(original, SNS, 2000, now_ms=1000)
        self.assertNotIn(b'\n', patched.replace(b'\r\n', b''))
        self.assertEqual(m.restore(patched, state), original)

    def test_new_credentials_survive_rollback(self):
        patched, state = m.enable(b'LLM_KEY=old-example\n', SNS, 2000, now_ms=1000)
        newer = patched.replace(b'old-example', b'rotated-example') + b'NEW_FEATURE=keep\n'
        self.assertEqual(m.restore(newer, state), b'LLM_KEY=rotated-example\nNEW_FEATURE=keep\n')

    def test_target_drift_is_refused(self):
        patched, state = m.enable(b'OTHER=ok\n', SNS, 2000, now_ms=1000)
        with self.assertRaises(ValueError):
            m.restore(patched.replace(b'=2000', b'=3000'), state)

    def test_duplicate_target_is_refused(self):
        with self.assertRaises(ValueError):
            m.enable(ALLOW+b'=one\n'+ALLOW+b'=two\n', SNS, 2000, now_ms=1000)

    def test_wrong_scope_or_deadline_is_refused(self):
        for sns, until in [(SNS[:2], 2000), (SNS+[SNS[0]], 2000), ([SNS[0]]*3, 2000),
                           ([s[-8:] for s in SNS], 2000), (SNS, 1000), (SNS, True)]:
            with self.subTest(sns=sns, until=until), self.assertRaises(ValueError):
                m.enable(b'OTHER=ok\n', sns, until, now_ms=1000)

    def test_restore_cannot_change_unrelated_key(self):
        patched, state = m.enable(b'LLM_KEY=keep\n', SNS, 2000, now_ms=1000)
        state['before']['LLM_KEY'] = None
        with self.assertRaises(ValueError): m.restore(patched, state)

    def test_no_terminal_newline_is_refused(self):
        with self.assertRaises(ValueError):
            m.enable(b'LLM_KEY=keep', SNS, 2000, now_ms=1000)

    def test_ambiguous_multiline_target_is_refused(self):
        with self.assertRaises(ValueError):
            m.enable(ALLOW+b'="unclosed\nvalue"\n', SNS, 2000, now_ms=1000)

    def test_repeated_restore_refuses_missing_installed_values(self):
        patched, state = m.enable(b'OTHER=ok\n', SNS, 2000, now_ms=1000)
        restored = m.restore(patched, state)
        with self.assertRaises(ValueError): m.restore(restored, state)

    def test_foreign_multiline_cannot_be_mistaken_for_target(self):
        original = b'OTHER="first\n'+ALLOW+b'=inside-other-value\nlast"\n'
        with self.assertRaises(ValueError): m.enable(original, SNS, 2000, now_ms=1000)

    def test_foreign_continuation_is_refused(self):
        original = b'OTHER=first\\\n'+ALLOW+b'=continuation\n'
        with self.assertRaises(ValueError): m.enable(original, SNS, 2000, now_ms=1000)

    def test_comment_quotes_are_not_assignments(self):
        original = b'# author\'s comment "not a value\nOTHER=yes\n'
        patched, state = m.enable(original, SNS, 2000, now_ms=1000)
        self.assertEqual(m.restore(patched, state), original)


if __name__ == '__main__': unittest.main()
