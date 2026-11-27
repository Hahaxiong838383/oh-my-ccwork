"""Device snapshots and owner controls, with a private Unix-socket listener."""
from http.server import BaseHTTPRequestHandler
import json
import os
import re
import socketserver
import stat
import threading
import time
import uuid

PHASES = {'idle','listening','speaking','thinking','searching','muted','connecting','error'}
ACTIONS = {'sync_logs','check_update'}
COLOR = re.compile(r'#[a-fA-F0-9]{6}')
ID = re.compile(r'[a-f0-9]{32}')
SCHEMA = """
CREATE TABLE IF NOT EXISTS mobile_devices (
 device TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'idle',
 muted INTEGER NOT NULL DEFAULT 0, accent TEXT, revision INTEGER NOT NULL DEFAULT 0,
 applied INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0,
 cmd TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
 created INTEGER NOT NULL DEFAULT 0, acked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device,ts DESC);
"""


class DeviceLink:
    def __init__(self, store, allowlist):
        self.store = store
        self.allowlist = allowlist
        with store._lock, store.conn:
            store.conn.executescript(SCHEMA)

    def sync(self, device, body):
        fields = {'versionCode','phase','muted','accent','appliedRevision','ack'}
        if not isinstance(body,dict) or body.keys() != fields:
            raise ValueError('invalid_snapshot')
        version, applied, accent, ack = (body[k] for k in ('versionCode','appliedRevision','accent','ack'))
        if (type(version) is not int or not 1 <= version <= 2100000000
                or type(applied) is not int or not 0 <= applied <= 2147483647
                or not isinstance(body['phase'],str) or body['phase'] not in PHASES or type(body['muted']) is not bool
                or not isinstance(accent,str) or not COLOR.fullmatch(accent)
                or not isinstance(ack,str) or (ack and not ID.fullmatch(ack))):
            raise ValueError('invalid_snapshot')
        accent = accent.upper()
        db = self.store.conn
        now = int(time.time())
        with self.store._lock, db:
            db.execute('INSERT OR IGNORE INTO mobile_devices(device) VALUES(?)',(device,))
            color, rev, confirmed, cmd, action, acked = db.execute(
                'SELECT accent,revision,applied,cmd,action,acked FROM mobile_devices WHERE device=?',(device,)).fetchone()
            if color is None or (applied == rev and color != accent):
                color, rev = accent, rev + 1
                confirmed = rev  # The submitted phone already displays this color.
            elif applied == rev and color == accent:
                confirmed = rev
            if cmd and ack == cmd and not acked:
                acked = now
            db.execute('UPDATE mobile_devices SET version=?,phase=?,muted=?,accent=?,revision=?,applied=?,seen=?,acked=? WHERE device=?',
                       (version,body['phase'],body['muted'],color,rev,confirmed,now,acked,device))
        return {'device':device,'revision':rev,'accent':color,
                'command':{'id':cmd,'action':action} if cmd and not acked else None}

    def devices(self):
        devices = []
        db = self.store.conn
        names = self.allowlist.devices()
        with self.store._lock:
            for name in names:
                row = db.execute('SELECT version,phase,muted,accent,revision,applied,seen,cmd,action,created,acked '
                                 'FROM mobile_devices WHERE device=?',(name,)).fetchone()
                events = db.execute('SELECT kind,ts,version_code FROM events WHERE device=? ORDER BY ts DESC LIMIT 16',(name,)).fetchall()
                version, phase, muted, color, rev, applied, seen, cmd, action, created, acked = (
                    row or (0,'idle',0,None,0,0,0,'','',0,0))
                devices.append(dict(device=name,versionCode=version or (events[0][2] if events else 0),
                                    phase=phase,muted=bool(muted),accent=color,revision=rev,appliedRevision=applied,
                                    lastSeen=seen,events=[dict(kind=k,ts=t) for k,t,v in events],
                                    command=dict(id=cmd,action=action,createdAt=created,ackedAt=acked,
                                    status='acked' if acked else 'pending') if cmd else None))
        return {'devices':devices}

    def change(self, device, kind, body):
        if device not in self.allowlist.devices():
            return 404, {'error':'unknown_device'}
        db = self.store.conn
        with self.store._lock, db:
            if kind == 'color':
                if not isinstance(body,dict) or body.keys() != {'accent'} or not isinstance(body['accent'],str) or not COLOR.fullmatch(body['accent']):
                    return 400, {'error':'bad_color'}
                color = body['accent'].upper()
                db.execute('INSERT INTO mobile_devices(device,accent,revision) VALUES(?,?,1) ON CONFLICT(device) DO UPDATE '
                           'SET accent=excluded.accent,revision=revision+1 WHERE accent IS NOT excluded.accent',(device,color))
            elif kind == 'command':
                if not isinstance(body,dict) or body.keys() != {'action'} or not isinstance(body['action'],str) or body['action'] not in ACTIONS:
                    return 400, {'error':'bad_action'}
                db.execute('INSERT OR IGNORE INTO mobile_devices(device) VALUES(?)',(device,))
                changed = db.execute("UPDATE mobile_devices SET cmd=?,action=?,created=?,acked=0 WHERE device=? AND (cmd='' OR acked>0)",
                                     (uuid.uuid4().hex,body['action'],int(time.time()),device))
                if changed.rowcount != 1:
                    return 409, {'error':'command_pending'}
            else:
                return 404, {'error':'not_found'}
        return 200, {'ok':True}


def owner_socket(path, link):
    class OwnerHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, status, data):
            body = json.dumps(data, separators=(',',':')).encode()
            self.send_response(status)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == '/devices':
                self.respond(200,link.devices())
            else:
                self.respond(404,{'error':'not_found'})

        def do_POST(self):
            target = re.fullmatch(r'/devices/([A-Za-z0-9][A-Za-z0-9._-]{0,31})/(color|command)', self.path)
            if not target:
                return self.respond(404,{'error':'not_found'})
            try:
                size = int(self.headers.get('Content-Length','0'))
                if not 1 <= size <= 1024:
                    raise ValueError()
                data = json.loads(self.rfile.read(size))
            except (ValueError,UnicodeError):
                return self.respond(400,{'error':'invalid_body'})
            self.respond(*link.change(*target.groups(),data))

    if os.path.lexists(path):
        if not stat.S_ISSOCK(os.lstat(path).st_mode):
            raise OSError('unexpected file at device bridge socket')
        os.unlink(path)
    server = socketserver.ThreadingUnixStreamServer(path,OwnerHandler)
    os.chmod(path,0o660)
    threading.Thread(target=server.serve_forever,name='owner-device-link',daemon=True).start()
    return server
