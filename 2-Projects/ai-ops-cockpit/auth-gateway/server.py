import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


USER = os.environ.get("OPS_AUTH_USER", "chuan")
PASSWORD = os.environ["OPS_AUTH_PASSWORD"]
SECRET = os.environ["OPS_AUTH_SECRET"]
FIXED_COOKIE = os.environ.get("OPS_AUTH_COOKIE", "")
COOKIE_NAME = "ops_auth"
MAX_AGE = int(os.environ.get("OPS_AUTH_MAX_AGE", "2592000"))
N8N_EMAIL = os.environ.get("N8N_EMAIL", "")
N8N_PASSWORD = os.environ.get("N8N_PASSWORD", "")
N8N_URL = os.environ.get("N8N_URL", "http://n8n:5678")


def sign(payload: str) -> str:
    return hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_token() -> str:
    exp = int(time.time()) + MAX_AGE
    payload = f"{USER}:{exp}"
    raw = f"{payload}:{sign(payload)}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def check_token(token: str) -> bool:
    try:
        padded = token + "=" * (-len(token) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode()).decode()
        user, exp, signature = decoded.rsplit(":", 2)
        payload = f"{user}:{exp}"
        return (
            user == USER
            and int(exp) >= int(time.time())
            and hmac.compare_digest(signature, sign(payload))
        )
    except Exception:
        return False


def has_ops_cookie(headers) -> bool:
    jar = cookies.SimpleCookie(headers.get("Cookie", ""))
    morsel = jar.get(COOKIE_NAME)
    return bool(
        morsel
        and (
            (FIXED_COOKIE and hmac.compare_digest(morsel.value, FIXED_COOKIE))
            or check_token(morsel.value)
        )
    )


def basic_ok(headers) -> bool:
    auth = headers.get("Authorization", "")
    if not auth.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(auth.split(" ", 1)[1], validate=True).decode()
        username, password = decoded.split(":", 1)
    except Exception:
        return False
    return hmac.compare_digest(username, USER) and hmac.compare_digest(password, PASSWORD)


def make_ops_cookie() -> str:
    return (
        f"{COOKIE_NAME}={make_token()}; Path=/; Max-Age={MAX_AGE}; "
        "HttpOnly; Secure; SameSite=Lax"
    )


def n8n_login(browser_id: str):
    payload = json.dumps(
        {"emailOrLdapLoginId": N8N_EMAIL, "password": N8N_PASSWORD}
    ).encode()
    request = urllib.request.Request(
        f"{N8N_URL}/rest/login",
        data=payload,
        headers={"Content-Type": "application/json", "browser-id": browser_id or ""},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        body = response.read()
        set_cookies = response.headers.get_all("Set-Cookie") or []
        return response.status, set_cookies, body


class Handler(BaseHTTPRequestHandler):
    server_version = "ops-auth-gateway/3"

    def log_message(self, fmt, *args):
        return

    def send_ops_cookie(self):
        self.send_header("Set-Cookie", make_ops_cookie())

    def send_unauthorized(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="ops"')
        self.end_headers()

    def handle_n8n_login(self):
        cookie_authorized = has_ops_cookie(self.headers)
        basic_authorized = basic_ok(self.headers)
        if not cookie_authorized and not basic_authorized:
            self.send_unauthorized()
            return

        try:
            status, set_cookies, body = n8n_login(self.headers.get("browser-id", ""))
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            if basic_authorized and not cookie_authorized:
                self.send_ops_cookie()
            for value in set_cookies:
                self.send_header("Set-Cookie", value)
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as error:
            self.send_response(error.code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(error.read())
        except Exception:
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'{"status":"error","message":"n8n login unavailable"}')

    def do_GET(self):
        if self.path.startswith("/health"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return

        if self.path.startswith("/n8n-login"):
            self.handle_n8n_login()
            return

        if has_ops_cookie(self.headers):
            self.send_response(204)
            self.end_headers()
            return

        if basic_ok(self.headers):
            self.send_response(204)
            self.send_ops_cookie()
            self.end_headers()
            return

        self.send_unauthorized()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
