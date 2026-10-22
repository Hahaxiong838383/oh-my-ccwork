import unittest
from verify_text_environment import escaped_text_keys


class LiveTextEnvironmentTests(unittest.TestCase):
    def test_literal_json_escape_fails_but_real_chinese_passes(self):
        self.assertEqual(escaped_text_keys({'INTERRUPT_HOTWORDS': r'\u505c,\u505c\u4e00\u4e0b'}), ['INTERRUPT_HOTWORDS'])
        self.assertEqual(escaped_text_keys({'INTERRUPT_HOTWORDS': '停,停一下'}), [])

    def test_only_audited_public_text_keys_are_inspected(self):
        self.assertEqual(escaped_text_keys({'SECRET_TOKEN': r'\u1234', 'AGENT_GREETING': '你好'}), [])
        self.assertEqual(escaped_text_keys({}), [])


if __name__ == '__main__':
    unittest.main()
