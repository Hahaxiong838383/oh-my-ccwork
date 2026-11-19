"""Observe executable bytes on hk2 and published files on aliyun-hk. No remote writes."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shlex
import subprocess

# Fixed sampling scope from the accepted deployment manifest. Archive and runtime data are excluded.
RECEIPT = '60329d989c68ae749ad7ebc01b19be184fd17a45:tasks/P003分支收拢.md'
WORKERS = """set -eu
units=$(systemctl list-units --state=running --type=service --no-legend --plain 'voice-worker*.service' 'p003-*-worker.service')
for unit in $(printf '%s\\n' "$units" | awk '{print $1}'); do
    pid=$(systemctl show "$unit" -p MainPID --value)
    test "$pid" -gt 0
    digest=$(sha256sum "/proc/$pid/exe")
    test "$pid" = "$(systemctl show "$unit" -p MainPID --value)"
    printf '%s %s\\n' "$unit" "${digest%% *}"
done"""
SERVER = """import hashlib,json,os,pathlib,sys
root=pathlib.Path('/opt/p003/server')
pids=list(pathlib.Path('/root/.pm2/pids').glob('p003-voice-*.pid'))
assert len(pids)==1
pid=pids[0].read_text().strip()
assert pid.isdigit() and pathlib.Path('/proc',pid,'cwd').resolve()==root
paths=json.load(sys.stdin)
digest=hashlib.sha256()
for name in sorted(paths):
    raw=(root/name).read_bytes()
    digest.update(name.encode()+b'\\0'+hashlib.sha256(raw).digest())
admin=pathlib.Path('/opt/p003/web/dist/admin/index.html').read_bytes()
assert admin and pids[0].read_text().strip()==pid
print(json.dumps({'p003-voice':digest.hexdigest(),'p003-admin':hashlib.sha256(admin).hexdigest()}))"""


def manifest_paths():
    text = subprocess.check_output(['git', 'show', RECEIPT], text=True)
    table = text.split('| 相对 apps/server 路径 |')[1]
    paths = re.findall(r'^\| ([^|]+?) \| [0-9a-f]{32} \|', table, re.M)
    if len(set(paths)) != 245 or len(paths) != 245 or any(
            Path(p).is_absolute() or '..' in Path(p).parts for p in paths):
        raise ValueError('服务端 245 文件取证清单无效')
    return paths


def observe():
    conf = Path.home()/'.config/mycc-branch-audit/ssh_config'
    ssh = ['ssh', '-F', str(conf), '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
           '-oUpdateHostKeys=no', '-oConnectTimeout=8']
    paths = manifest_paths()
    worker = subprocess.check_output(ssh+['p003-audit-worker', WORKERS], text=True, timeout=45)
    result = dict(line.split() for line in worker.splitlines())
    server = subprocess.check_output(ssh+['p003-audit-server', 'python3 -c '+shlex.quote(SERVER)],
                                     input=json.dumps(paths), text=True, timeout=45)
    result.update(json.loads(server))
    return {'at': datetime.now(timezone.utc).isoformat(), 'components': result}
