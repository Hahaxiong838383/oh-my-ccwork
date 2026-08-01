import base64
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock


os.environ.setdefault("OPS_AUTH_PASSWORD", "test-password")
os.environ.setdefault("OPS_AUTH_SECRET", "test-secret")
os.environ.setdefault("N8N_EMAIL", "test@example.com")
os.environ.setdefault("N8N_PASSWORD", "test-n8n-password")

import server


def basic_header(username="chuan", password="test-password"):
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return f"Basic {token}"


class GatewayServerTest(unittest.TestCase):
    def setUp(self):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def request(self, path, headers=None):
        request = urllib.request.Request(self.base_url + path, headers=headers or {})
        return urllib.request.urlopen(request, timeout=3)

    def test_auth_accepts_basic_and_sets_ops_cookie(self):
        with self.request("/auth", {"Authorization": basic_header()}) as response:
            self.assertEqual(response.status, 204)
            self.assertIn("ops_auth=", response.headers.get("Set-Cookie", ""))

    def test_n8n_login_accepts_signed_cookie(self):
        token = server.make_token()
        with mock.patch.object(
            server,
            "n8n_login",
            return_value=(200, ["n8n-auth=n8n-token; Path=/; HttpOnly"], b'{"data":{}}'),
        ) as login:
            with self.request("/n8n-login", {"Cookie": f"ops_auth={token}"}) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b'{"data":{}}')
                self.assertEqual(response.headers.get_all("Set-Cookie"), ["n8n-auth=n8n-token; Path=/; HttpOnly"])
            login.assert_called_once_with("")

    def test_n8n_login_accepts_basic_and_sets_both_cookies(self):
        with mock.patch.object(
            server,
            "n8n_login",
            return_value=(200, ["n8n-auth=n8n-token; Path=/; HttpOnly"], b'{"data":{}}'),
        ):
            headers = {"Authorization": basic_header(), "browser-id": "browser-test"}
            with self.request("/n8n-login", headers) as response:
                self.assertEqual(response.status, 200)
                set_cookies = response.headers.get_all("Set-Cookie")
                self.assertEqual(len(set_cookies), 2)
                self.assertTrue(any(value.startswith("ops_auth=") for value in set_cookies))
                self.assertIn("n8n-auth=n8n-token; Path=/; HttpOnly", set_cookies)

    def test_n8n_login_rejects_wrong_basic_credentials(self):
        with mock.patch.object(server, "n8n_login") as login:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.request(
                    "/n8n-login",
                    {"Authorization": basic_header(password="wrong-password")},
                )
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
            login.assert_not_called()

    def test_n8n_login_rejects_missing_credentials(self):
        with mock.patch.object(server, "n8n_login") as login:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.request("/n8n-login")
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
            login.assert_not_called()


if __name__ == "__main__":
    unittest.main()
