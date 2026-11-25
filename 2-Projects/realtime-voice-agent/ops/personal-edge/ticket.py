"""Device registry and LiveKit ticket service for the personal edge."""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


STATE = Path("/var/lib/personal-edge-ticket/devices.sqlite3")
URL = os.environ.get("PERSONAL_EDGE_PUBLIC_URL", "wss://60.205.5.246:18784")
ORIGIN = URL.replace("wss:", "https:")
AGENT = "personal-xiaoke"
LIFETIME = 120
ISSUE_INTERVAL = 3
ID = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
BEARER = re.compile(r"(?i:Bearer) (pv1_[a-f0-9]{64})")


def database():
    db = sqlite3.connect(STATE, timeout=5)
    db.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            owner TEXT NOT NULL,
            device TEXT NOT NULL,
            digest BLOB UNIQUE NOT NULL,
            revoked_at INTEGER,
            last_ticket INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (owner, device)
        )
    """)
    return db


def digest(credential):
    return hashlib.sha256(credential.encode("ascii")).digest()


def issue(db, credential, now):
    # Serialize issuing and revoking so the credential is checked within the write transaction.
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT owner, device, last_ticket FROM devices WHERE digest = ? AND revoked_at IS NULL",
            (digest(credential),),
        ).fetchone()
        if row is None:
            return 401, None
        owner, device, last_ticket = row
        if now - last_ticket < ISSUE_INTERVAL:
            return 429, None
        db.execute(
            "UPDATE devices SET last_ticket = ? WHERE owner = ? AND device = ?",
            (now, owner, device),
        )
        return 200, (owner, device)


def jwt(claims, secret):
    def encode(data):
        return base64.urlsafe_b64encode(data).rstrip(b"=")

    def segment(value):
        return encode(json.dumps(value, separators=(",", ":")).encode())

    unsigned = segment({"alg": "HS256", "typ": "JWT"}) + b"." + segment(claims)
    return (unsigned + b"." + encode(hmac.digest(secret, unsigned, "sha256"))).decode("ascii")


class TicketServer(HTTPServer):
    def get_request(self):
        client, address = super().get_request()
        client.settimeout(5)
        return client, address


class TicketHandler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def reply(self, status, payload):
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if status == 429:
            self.send_header("Retry-After", str(ISSUE_INTERVAL))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/healthz":
            self.reply(200, {"service": "personal-edge-ticket"})
        else:
            self.reply(405, {"error": "method_not_allowed"})

    def do_POST(self):
        if self.path != "/api/voice/ticket":
            self.reply(404, {"error": "not_found"})
            return
        if self.headers.get("Origin", ORIGIN) != ORIGIN:
            self.reply(403, {"error": "invalid_origin"})
            return
        # The client cannot override the trusted owner, device, room or dispatch name.
        if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length", "0") != "0":
            self.reply(400, {"error": "empty_body_required"})
            return
        authorization = self.headers.get_all("Authorization") or []
        match = BEARER.fullmatch(authorization[0]) if len(authorization) == 1 else None
        if not match:
            self.reply(401, {"error": "invalid_device"})
            return
        now = int(time.time())
        try:
            with closing(database()) as db:
                status, identity = issue(db, match[1], now)
        except sqlite3.Error:
            self.reply(503, {"error": "ticket_unavailable"})
            return
        if status != 200:
            self.reply(status, {"error": "invalid_device" if status == 401 else "rate_limited"})
            return
        owner, device = identity
        room = "pv-" + secrets.token_hex(16)
        token = jwt({
            "iss": self.server.api_key,
            "sub": f"personal:{owner}:{device}",
            "nbf": now - 5,
            "exp": now + LIFETIME,
            "video": {
                "room": room, "roomJoin": True, "canPublish": True,
                "canPublishSources": ["microphone"], "canSubscribe": True,
                "canPublishData": True,
            },
            "roomConfig": {
                "agents": [{
                    "agentName": AGENT,
                    "metadata": json.dumps({"owner_id": owner, "device_id": device}),
                }],
            },
        }, self.server.api_secret)
        self.reply(200, {"url": URL, "token": token, "room": room})


def serve():
    key_file = Path(os.environ["CREDENTIALS_DIRECTORY"], "livekit.keys")
    api_key, api_secret = key_file.read_text().strip().split(": ", 1)
    if not api_key or len(api_secret) < 32:
        raise ValueError("invalid LiveKit key file")
    with closing(database()):
        pass
    with TicketServer(("127.0.0.1", 18781), TicketHandler) as server:
        server.api_key = api_key
        server.api_secret = api_secret.encode("ascii")
        server.serve_forever()


def provision(args):
    credential = "pv1_" + secrets.token_hex(32)
    args.output = args.output.absolute()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    with closing(database()) as db:
        created = False
        try:
            with db:
                changed = db.execute(
                    """INSERT INTO devices(owner, device, digest) VALUES (?, ?, ?)
                    ON CONFLICT(owner, device) DO UPDATE SET
                        digest = excluded.digest, revoked_at = NULL, last_ticket = 0
                    WHERE devices.revoked_at IS NOT NULL""",
                    (args.owner, args.device, digest(credential)),
                )
                if changed.rowcount != 1:
                    raise SystemExit("this owner and device already have an active credential")
                with os.fdopen(os.open(args.output, flags, 0o600), "w") as stream:
                    created = True
                    stream.write(credential + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
        except BaseException:
            if created:
                args.output.unlink()
            raise
    print(f"Created {args.owner}/{args.device}")


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve")
    commands.add_parser("list")
    add = commands.add_parser("add")
    revoke = commands.add_parser("revoke")
    for command in (add, revoke):
        command.add_argument("owner")
        command.add_argument("device")
    add.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "serve":
        serve()
        return
    if args.command == "list":
        with closing(database()) as db:
            for owner, device, revoked_at in db.execute(
                "SELECT owner, device, revoked_at FROM devices ORDER BY owner, device"
            ):
                print(owner, device, "revoked" if revoked_at else "active")
        return
    if not ID.fullmatch(args.owner) or not ID.fullmatch(args.device):
        parser.error("owner and device must be lowercase identifiers of up to 32 characters")
    if args.command == "add":
        provision(args)
    else:
        with closing(database()) as db, db:
            changed = db.execute(
                "UPDATE devices SET revoked_at = ? WHERE owner = ? AND device = ? AND revoked_at IS NULL",
                (int(time.time()), args.owner, args.device),
            )
            if changed.rowcount != 1:
                parser.error("no active credential for this owner and device")
        print(f"Revoked {args.owner}/{args.device}")


if __name__ == "__main__":
    main()
