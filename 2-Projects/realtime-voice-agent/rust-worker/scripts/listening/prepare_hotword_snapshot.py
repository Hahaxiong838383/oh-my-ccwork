#!/usr/bin/env python3
"""Offline v380 canary snapshot preparation, never deployment or API mutation.

Input is GET /api/admin/hotwords AFTER a successful ordinary publish. Only the
approved two-term prefix may differ from this pool's old ASR list. A concurrent
draft, stale file, changed device list or other drift requires re-investigation.
Output contains the original private environment: exclusive 0600 file, no stdout.
The deployment owner must separately verify idle jobs, install, restart and check
process values. DB publication alone does not update an independent canary pool.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re


def sha(data):
    return hashlib.sha256(data).hexdigest()


def prepare(snapshot, old, expected_sha):
    if sha(old) != expected_sha or snapshot.get('channel_ok') is not True:
        raise ValueError('stale_environment_or_channel_unverified')
    lines = old.decode('utf-8').splitlines(keepends=True)
    receipt = {'before_sha256': sha(old), 'changed_keys': [], 'published': {}}
    for kind, key in [('asr', 'VOLC_ASR_HOTWORDS'), ('device_asr', 'P003_DEVICE_ASR_HOTWORDS')]:
        item = snapshot['kinds'][kind]
        pub = item.get('published') or {}
        words = pub.get('words')
        if (item.get('env_key') != key or item.get('live_in_sync') is not True
                or item.get('draft') is not None or pub.get('status') != 'published'
                or not isinstance(pub.get('version'), int) or pub['version'] < 1
                or not isinstance(words, list) or not 1 <= len(words) <= 500
                or not all(isinstance(w, str) and 1 <= len(w) <= 20
                           and w == w.strip() and re.fullmatch(r'[一-鿿A-Za-z0-9 ]+', w) for w in words)
                or len(set(words)) != len(words) or item.get('live') != words):
            raise ValueError('published_snapshot_unverified')
        indices = [i for i, line in enumerate(lines) if line.startswith(key + '=')]
        if len(indices) != 1:
            raise ValueError('missing_or_duplicate_environment_key')
        i = indices[0]
        raw = lines[i][len(key) + 1:].rstrip('\r\n').strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
            raw = raw[1:-1]
        before = [w.strip() for w in raw.split(',') if w.strip()]
        allowed = ['补勤卡', '补签卡'] + [w for w in before if w not in ['补勤卡', '补签卡']]
        if (kind == 'asr' and words != allowed) or (kind == 'device_asr' and words != before):
            raise ValueError('unapproved_pool_drift')
        if words != before:
            ending = '\r\n' if lines[i].endswith('\r\n') else '\n' if lines[i].endswith('\n') else ''
            lines[i] = key + '=' + ','.join(words) + ending
            receipt['changed_keys'].append(key)
        receipt['published'][kind] = {'id': pub.get('id'), 'version': pub['version'],
                                      'word_count': len(words), 'value_sha256': sha(','.join(words).encode())}
    new = ''.join(lines).encode('utf-8')
    receipt['after_sha256'] = sha(new)
    receipt['deployed'] = False
    return new, receipt


def exclusive(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--expected-env-sha', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    paths = [Path(v).resolve() for v in [args.snapshot, args.env_file, args.output, args.receipt]]
    if len(set(paths)) != 4 or any(p.exists() for p in paths[2:]):
        raise ValueError('outputs_must_be_new_separate_files')
    new, receipt = prepare(json.loads(paths[0].read_text()), paths[1].read_bytes(), args.expected_env_sha)
    exclusive(paths[2], new)
    exclusive(paths[3], (json.dumps(receipt, indent=2, ensure_ascii=False) + '\n').encode())


if __name__ == '__main__':
    main()
