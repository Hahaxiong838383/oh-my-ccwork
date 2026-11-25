"""One-shot HTTPS receiver for the pinned public LiveKit artifact."""
import hashlib
import os
import ssl
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SIZE = 19_464_037
SHA256 = "1e9ee90ca301e1842b2887fc77cb122759756a9c8aeb4334ee91de3325ec43fb"
DESTINATION = Path("private/livekit-release.tar.gz")


class Receiver(BaseHTTPRequestHandler):
    def do_PUT(self):
        if self.path != "/livekit-release" or self.headers.get("Content-Length") != str(SIZE):
            self.send_error(400)
            return
        self.connection.settimeout(10)
        candidate = DESTINATION.with_suffix(".upload")
        digest = hashlib.sha256()
        try:
            with candidate.open("xb") as stream:
                remaining = SIZE
                while remaining:
                    data = self.rfile.read(min(remaining, 128 * 1024))
                    if not data:
                        raise ValueError("truncated upload")
                    stream.write(data)
                    digest.update(data)
                    remaining -= len(data)
            if digest.hexdigest() != SHA256:
                raise ValueError("checksum mismatch")
            candidate.rename(DESTINATION)
        except (OSError, ValueError):
            candidate.unlink(missing_ok=True)
            self.send_error(400)
            return
        self.send_response(201)
        self.end_headers()


os.umask(0o077)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("pki/server.crt", "private/server.key")
with HTTPServer(("0.0.0.0", 18784), Receiver) as server:
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.socket.settimeout(5)
    server.timeout = 5
    deadline = time.monotonic() + 55
    while not DESTINATION.exists() and time.monotonic() < deadline:
        server.handle_request()
if not DESTINATION.exists():
    raise SystemExit("no verified release uploaded")
