import unittest
from unittest import mock

import server


class VibePageTest(unittest.TestCase):
    def test_terminal_is_lazy_and_requires_explicit_click(self):
        status = {
            "ok": True,
            "sessions": [],
            "terminal": {"ok": True},
            "omp": {"ok": True},
        }
        with mock.patch.object(server, "vibe_status_payload", return_value=status):
            page = server.render_vibe_page()
        self.assertIn('id="terminalFrame" src="about:blank" data-src="/terminal/"', page)
        self.assertIn('id="startTerminalBtn"', page)
        self.assertIn("startTerminalBtn.addEventListener", page)
        self.assertNotIn('<iframe src="/terminal/" title="Vibe Terminal">', page)


if __name__ == "__main__":
    unittest.main()
