import unittest
import os
import pathlib
import subprocess
import sys
from verify_text_environment import escaped_text_keys


class LiveTextEnvironmentTests(unittest.TestCase):
    def test_literal_json_escape_fails_but_real_chinese_passes(self):
        self.assertEqual(escaped_text_keys({'INTERRUPT_HOTWORDS': r'\u505c,\u505c\u4e00\u4e0b'}), ['INTERRUPT_HOTWORDS'])
        self.assertEqual(escaped_text_keys({'INTERRUPT_HOTWORDS': '停,停一下'}), [])

    def test_only_audited_public_text_keys_are_inspected(self):
        self.assertEqual(escaped_text_keys({'SECRET_TOKEN': r'\u1234', 'AGENT_GREETING': '你好'}), [])
        self.assertEqual(escaped_text_keys({}), [])

    def test_prestart_checks_actual_inherited_values_without_disclosing_them(self):
        script = pathlib.Path(__file__).with_name('verify_text_environment.py')
        for value, expected in [(r'\u505c', 1), ('停,停一下', 0)]:
            env = {**os.environ, 'INTERRUPT_HOTWORDS': value,
                   'SECRET_TOKEN': 'NEVER_PRINT_THIS'}
            result = subprocess.run([sys.executable, str(script), '--current-env'],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, expected, result.stderr)
            self.assertNotIn('NEVER_PRINT_THIS', result.stdout + result.stderr)
            self.assertNotIn(value, result.stdout + result.stderr)
            self.assertIn('INTERRUPT_HOTWORDS', result.stdout)


if __name__ == '__main__':
    unittest.main()
