import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('x_read', Path(__file__).with_name('x-read.py'))
x = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x)


class PublicPostReaderTests(unittest.TestCase):
    def test_normalize_and_strip_tracking(self):
        self.assertEqual(x.canonical_post('https://twitter.com/jack/status/20?s=21#top'), ('https://x.com/jack/status/20', '20'))
        self.assertEqual(x.canonical_post('https://x.com/i/web/status/20')[1], '20')

    def test_no_arbitrary_fetch_or_credentials(self):
        for url in ['http://x.com/jack/status/20', 'https://x.com.evil.invalid/jack/status/20',
                    'https://secret@x.com/jack/status/20', 'https://x.com:8443/jack/status/20',
                    'https://x.com/search?q=private', 'https://x.com/jack', 'file:///tmp/key']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                x.canonical_post(url)

    def test_only_post_text_not_script_or_signature(self):
        result = x.extract_post({'type': 'rich', 'author_name': 'Example', 'html':
            '<blockquote><p>Hello &amp; <a href="https://x.com/test">world</a><br>next</p>— author<script>bad()</script></blockquote>'}, 'https://x.com/example/status/1', '1')
        self.assertEqual(result['text'], 'Hello & world\nnext')

    def test_widget_shell_is_not_a_post(self):
        with self.assertRaises(ValueError):
            x.extract_post({'type': 'rich', 'author_name': 'Example', 'html': '<a>Posts by Example</a>'}, 'url', '1')


if __name__ == '__main__':
    unittest.main()
