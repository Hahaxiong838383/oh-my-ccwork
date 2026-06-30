#!/usr/bin/env bash
set -euo pipefail

MULTICA_BIN="${MULTICA_BIN:-/Users/rayman.chen/bin/multica}"
SSH_HOST="${SSH_HOST:-mini}"

run_remote() {
  ssh "$SSH_HOST" "$@"
}

run_remote "python3 - <<'PY'
import json
import subprocess
import sys

multica = '${MULTICA_BIN}'

checks = [
    ('agent', 'a56c3666-8f04-4204-8697-d8b928807a7a', 'instructions', 'Prompt Shard Kernel', 'grok-fast'),
    ('agent', 'f7b19bfb-e53a-4ea1-a415-127c593287e8', 'instructions', 'Prompt Shard Kernel', 'grok-deep'),
    ('agent', '9c78bbda-0cb3-4a24-bfea-d02268728680', 'instructions', 'Prompt Shard Kernel', 'gemma'),
    ('skill', '54d94775-5dda-4024-afd7-9c950ebb2f91', 'content', 'Prompt Shard Kernel', 'feishu-skill'),
    ('skill', '6b8ca900-ba60-4d68-aaa5-f7f161af2fac', 'content', 'Prompt Shard Kernel', 'theory-radar-skill'),
]

for kind, ident, field, needle, label in checks:
    raw = subprocess.check_output([multica, kind, 'get', ident, '--output', 'json'], text=True)
    data = json.loads(raw)
    value = data.get(field) or ''
    if needle not in value:
        print(f'FAIL {label}: missing {needle}')
        sys.exit(1)
    forbidden = [item for item in ['{antml:', 'The assistant is Claude', '/mnt/user-data'] if item in value]
    if forbidden:
        print(f'FAIL {label}: forbidden residue {forbidden}')
        sys.exit(1)
    print(f'OK {label}: len={len(value)}')

print('live prompt shards validation passed')
PY"

