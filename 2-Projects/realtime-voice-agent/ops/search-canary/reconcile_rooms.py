#!/usr/bin/env python3
"""Scoped durable room cleanup, with separate candidate and business ownership. No user text or credentials in records."""
import argparse
import base64
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import time
import urllib.error
import urllib.parse
import urllib.request


def read_record(path):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags), 'rb') as f:
        s = os.fstat(f.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > 4096:
            raise ValueError('invalid_record_file')
        raw = f.read(4097)
    value = json.loads(raw)
    if (not isinstance(value, dict) or value.get('schema') not in (1, 2)
            or not re.fullmatch(r'sn-BJP003\d{14}-\d{1,20}', value.get('room', ''))
            or not re.fullmatch(r'RM_[A-Za-z0-9_-]{1,100}', value.get('sid', ''))
            or value.get('state') not in ('active', 'closing')
            or not isinstance(value.get('generation'), str) or not value['generation']
            or len(value['generation']) > 128
            or any(type(value.get(k)) is not int or value[k] <= 0
                   for k in ('updated_at_ms', 'pid'))
            or type(value.get('deadline_ms')) is not int
            or (value['schema'] == 1 and value['deadline_ms'] <= 0)
            or (value['schema'] == 2 and (value['deadline_ms'] != 0
                or not re.fullmatch(r'cfg-\d{1,20}', value['generation'])))
            or not re.fullmatch(r'\d{1,30}', value.get('process_start', ''))):
        raise ValueError('invalid_record')
    return raw, value


def remove_unchanged(path, raw, status):
    # A delayed cleanup must not remove a newly written lifecycle record.
    try:
        if read_record(path)[0] != raw:
            return {'status': 'record_changed'}
        path.unlink()
        return {'status': status}
    except FileNotFoundError:
        return {'status': status}


def listed_room(api, name):
    result = api.post('ListRooms', {'names': [name]})
    rooms = result.get('rooms')
    if not isinstance(rooms, list) or len(rooms) > 1:
        raise ValueError('invalid_list_response')
    if not rooms:
        return None
    room = rooms[0]
    if not isinstance(room, dict) or room.get('name') != name or not isinstance(room.get('sid'), str):
        raise ValueError('invalid_room_identity')
    return room['sid']


def reconcile(path, window, api, now_ms, owner_alive, only_subject=None, mode="candidate"):
    try:
        raw, record = read_record(path)
    except FileNotFoundError:
        return {'status': 'gone'}
    except (ValueError, TypeError, OSError):
        return {'status': 'invalid'}
    if (mode not in ('candidate', 'business')
            or record['schema'] != (2 if mode == 'business' else 1)):
        return {'status': 'invalid'}
    sn = record['room'].split('-')[1]
    if only_subject is not None and sn != only_subject:
        return {'status': 'invalid'}
    allowed = window.get('allowlist') or [window.get('sn')]
    authorized = (window.get('enabled') is True and sn in allowed
                  and window.get('generation') == record['generation']
                  and window.get('expires_at_ms') == record['deadline_ms']
                  and now_ms < record['deadline_ms'])
    alive = owner_alive(record['pid'], record['process_start'])
    if record['state'] == 'active' and alive and (mode == 'business' or authorized):
        return {'status': 'active'}
    # Foreground HTTP attempts are bounded; avoid competing for 10 seconds.
    if record['state'] == 'closing' and alive and now_ms - record['updated_at_ms'] < 10000:
        return {'status': 'foreground'}
    try:
        sid = listed_room(api, record['room'])
        if sid is None:
            return remove_unchanged(path, raw, 'absent')
        if sid != record['sid']:
            return remove_unchanged(path, raw, 'superseded')
        # Recheck after the network await: a later local generation wins.
        if read_record(path)[0] != raw:
            return {'status': 'record_changed'}
        api.post('DeleteRoom', {'room': record['room']})
        after = listed_room(api, record['room'])
        if after == record['sid']:
            return {'status': 'pending', 'reason': 'room_still_present'}
        return remove_unchanged(path, raw, 'deleted')
    except (ValueError, TypeError, OSError, TimeoutError):
        # Keep the original record across process/timer restarts. Never log a
        # raw HTTP exception, which may contain endpoint query credentials.
        return {'status': 'pending', 'reason': 'control_request_failed'}


def process_alive(pid, start):
    try:
        fields = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
        return fields[19] == start and fields[0] != 'Z'
    except (OSError, IndexError):
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class RoomAPI:
    def __init__(self, endpoint, key, secret):
        parsed = urllib.parse.urlsplit(endpoint)
        if (parsed.scheme not in ('wss', 'ws') or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/')):
            raise ValueError('invalid_control_endpoint')
        if parsed.scheme == 'ws' and parsed.hostname not in ('127.0.0.1', '::1', 'localhost'):
            raise ValueError('cleartext_control_endpoint')
        if not key or not secret:
            raise ValueError('missing_control_credentials')
        scheme = 'https' if parsed.scheme == 'wss' else 'http'
        self.base = urllib.parse.urlunsplit((scheme, parsed.netloc, '', '', ''))
        self.key, self.secret = key, secret
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))

    def post(self, method, data):
        if method not in ('ListRooms', 'DeleteRoom'):
            raise ValueError('control_method_not_allowed')
        def b64(raw):
            return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()
        now = int(time.time())
        claims = {'iss': self.key, 'nbf': now, 'exp': now + 60,
                  'video': {'roomList': True} if method == 'ListRooms'
                  else {'roomCreate': True, 'room': data['room']}}
        unsigned = b64(b'{"alg":"HS256","typ":"JWT"}') + '.' + b64(json.dumps(claims).encode())
        token = unsigned + '.' + b64(hmac.new(self.secret.encode(), unsigned.encode(), hashlib.sha256).digest())
        req = urllib.request.Request(self.base + '/twirp/livekit.RoomService/' + method,
            data=json.dumps(data).encode(), headers={'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token}, method='POST')
        with self.opener.open(req, timeout=2) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError('control_response_oversize')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('invalid_control_response')
        return value


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--queue', type=Path, required=True)
    p.add_argument('--window', type=Path)
    p.add_argument('--mode', choices=('candidate', 'business'), default='candidate')
    p.add_argument('--status', type=Path, required=True)
    args = p.parse_args()
    agent = os.environ.get('AGENT_NAME')
    only_subject = None
    if args.mode == 'business':
        root = Path('/var/lib/p003-business-cleanup')
        if (agent != 'rust-worker' or args.window is not None
                or (args.queue, args.status) != (root / 'queue', root / 'status.json')
                or any(p.resolve() != p for p in (args.queue, args.status))):
            raise ValueError('business_cleanup_scope')
    elif args.window is None:
        raise ValueError('candidate_window_required')
    elif agent == 'p003-search-verification-20261026':
        root = Path('/opt/p003-search-verification-20261026')
        if ((args.queue, args.window, args.status) !=
                (root / 'room-cleanup', root / 'window.json', root / 'cleanup-status.json')
                or any(p.resolve() != p for p in (args.queue, args.window, args.status))):
            raise ValueError('verification_paths')
        only_subject = 'BJP00399999999999901'
    elif agent != 'p003-search-canary-20261021':
        raise ValueError('candidate_only')
    if not args.queue.is_absolute() or args.queue.resolve() != args.queue:
        raise ValueError('invalid_queue_directory')
    args.queue.mkdir(mode=0o700, parents=False, exist_ok=True)
    with (args.queue / '.reconcile.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            window = json.loads(args.window.read_text()) if args.window else {}
            if not isinstance(window, dict):
                window = {}
        except (ValueError, OSError):
            window = {}  # An unreadable authorization cannot keep an orphan active.
        api = RoomAPI(os.environ['LIVEKIT_URL'], os.environ['LIVEKIT_API_KEY'], os.environ['LIVEKIT_API_SECRET'])
        now = int(time.time() * 1000)
        counts = {}
        # One request stream, bounded records per tick. Jobs never wait on it.
        records = sorted(args.queue.glob('*.json'), key=lambda f: f.lstat().st_mtime)
        for path in records[:8]:
            result = reconcile(path, window, api, now, process_alive, only_subject=only_subject, mode=args.mode)
            key = result['status']
            counts[key] = counts.get(key, 0) + 1
            # Rotate unresolved and live records, so a quiet old room cannot
            # starve a newer cleanup intent on a later timer tick.
            try:
                os.utime(path, None, follow_symlinks=False)
            except FileNotFoundError:
                pass
        summary = {'mode': args.mode, 'at_ms': int(time.time() * 1000), 'counts': counts,
                   'remaining': len(list(args.queue.glob('*.json'))),
                   'healthy': not any(counts.get(k, 0) for k in ('pending', 'invalid', 'record_changed'))}
        temp = args.status.with_suffix('.tmp')
        with temp.open('w') as f:
            os.chmod(temp, 0o600)
            json.dump(summary, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, args.status)
        print(json.dumps(summary))


if __name__ == '__main__':
    main()
