import argparse
import datetime
import json
import os
import re
import runpy
import signal
import stat
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description='Validate the current company Studio Codeg service; read-only by default.')
parser.add_argument('--test-recovery', action='store_true', help='Maintenance only: SIGKILL the worker and launcher after confirming zero agent connections.')
args = parser.parse_args()
assert os.getuid() == 0
launcher_path = Path('/Library/Application Support/Codeg-company-studio/runner.py')
for path in [launcher_path.parent, launcher_path]:
    info = path.lstat()
    assert not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'Untrusted deployed launcher path'
launcher = runpy.run_path(str(launcher_path))
token = launcher['credential']()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def request(route, body=None, credential=token):
    headers = {}
    if credential is not None:
        headers['Authorization'] = 'Bearer ' + credential
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request('http://127.0.0.1:3080'+route, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with opener.open(req, timeout=3) as response:
            return response.status, response.headers.get('Content-Type', ''), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get('Content-Type', ''), error.read()

def health():
    code, content_type, content = request('/api/health', {})
    assert code == 200 and 'application/json' in content_type
    result = json.loads(content)
    assert result.get('status') == 'ok' and result.get('version') == '0.34.0'
    return result

def process_state():
    job = subprocess.run(['/bin/launchctl','print','system/cc.codeg-company-studio'], capture_output=True, text=True)
    assert job.returncode == 0
    runner = int(re.search(r'\n\s*pid = (\d+)', job.stdout).group(1))
    listening = subprocess.run(['/usr/sbin/lsof','-nP','-a','-iTCP:3080','-sTCP:LISTEN','-Fpcun'], capture_output=True, text=True)
    assert listening.returncode == 0
    worker = re.findall(r'^p(\d+)$', listening.stdout, re.M)
    addresses = re.findall(r'^n(.+)$', listening.stdout, re.M)
    assert len(worker) == 1 and addresses == ['*:3080']
    worker = int(worker[0])
    uid = subprocess.check_output(['/bin/ps','-o','uid=','-p',str(worker)],text=True).strip()
    runner_uid = subprocess.check_output(['/bin/ps','-o','uid=','-p',str(runner)],text=True).strip()
    assert uid == '501' and runner_uid == '501'
    worker_group = subprocess.check_output(['/bin/ps','-o','pgid=','-p',str(worker)],text=True).strip()
    runner_group = subprocess.check_output(['/bin/ps','-o','pgid=','-p',str(runner)],text=True).strip()
    assert worker_group == runner_group
    tree = subprocess.check_output(['/bin/ps','-axo','pid,ppid,uid,pgid,comm'],text=True)
    relevant = [line for line in tree.splitlines() if 'codeg-server' in line or re.match(r'\s*'+str(runner)+r'\s',line)]
    return {'runner_pid':runner,'worker_pid':worker,'uid':501,'process_group':int(runner_group),'listen_address':addresses[0],'system_job_running':'state = running' in job.stdout,'processes':relevant}

def check_logs():
    checked = []
    for path in list(Path('/Users/fu-121/Library/Application Support/Codeg-company-studio/logs').glob('service.log*')) + [Path('/var/log/codeg-company-studio.launchd.log')]:
        assert not path.is_symlink()
        assert token.encode() not in path.read_bytes(), 'Credential found in logs'
        assert path.stat().st_mode & 0o777 == 0o600
        checked.append(str(path))
    assert checked
    return checked

before = process_state()
assert health()
negative = {}
for label, secret in [('missing',None),('incorrect','invalid-installation-probe-token')]:
    code, _, _ = request('/api/health',{},secret)
    assert code == 401
    negative[label] = code
code, content_type, page = request('/')
assert code == 200 and 'text/html' in content_type and b'codeg' in page.lower()
assets = re.findall(rb'<script[^>]+src="([^\"]+\.js)"',page)
assert assets
code, js_type, javascript = request('/'+assets[0].decode().lstrip('./'))
assert code == 200 and len(javascript) > 10000 and ('javascript' in js_type or 'ecmascript' in js_type)
connections = request('/api/acp_list_connections',{})
assert connections[0] == 200
connection_list = json.loads(connections[2])
assert isinstance(connection_list, list)
if not args.test_recovery:
    result = {'validated_at':datetime.datetime.now().astimezone().isoformat(),'mode':'read-only','health':health(),'authorization_negative':negative,'frontend':{'html_bytes':len(page),'javascript_bytes':len(javascript),'javascript_asset':assets[0].decode()},'process':before,'current_agent_connections':len(connection_list),'logs_token_free':True,'logs_checked':check_logs(),'recovery_test_performed':False,'full_host_reboot_tested':False}
    assert token not in json.dumps(result)
    print(json.dumps(result,indent=2))
    raise SystemExit(0)
def require_idle():
    response = request('/api/acp_list_connections', {})
    assert response[0] == 200
    assert json.loads(response[2]) == [], 'Existing agent connection; refuse recovery test'

require_idle()
start = time.monotonic()
os.kill(before['worker_pid'],signal.SIGKILL)
after = None
while time.monotonic()-start < 45:
    time.sleep(0.5)
    try:
        health()
        candidate = process_state()
        if candidate['worker_pid'] != before['worker_pid'] and candidate['runner_pid'] != before['runner_pid']:
            after = candidate
            break
    except (AssertionError,ValueError,AttributeError,OSError,urllib.error.URLError,subprocess.SubprocessError):
        pass
assert after is not None, 'Crash restart failed'
recovery_s = round(time.monotonic()-start,3)
launcher_before = after
require_idle()
start = time.monotonic()
os.kill(launcher_before['runner_pid'],signal.SIGKILL)
launcher_after = None
while time.monotonic()-start < 45:
    time.sleep(0.5)
    try:
        health()
        candidate = process_state()
        if candidate['worker_pid'] != launcher_before['worker_pid'] and candidate['runner_pid'] != launcher_before['runner_pid']:
            launcher_after = candidate
            break
    except (AssertionError,ValueError,AttributeError,OSError,urllib.error.URLError,subprocess.SubprocessError):
        pass
assert launcher_after is not None, 'Launcher kill recovery failed'
launcher_recovery_s = round(time.monotonic()-start,3)

checked_logs = check_logs()
result = {'validated_at':datetime.datetime.now().astimezone().isoformat(),'health':health(),'authorization_negative':negative,'frontend':{'html_bytes':len(page),'javascript_bytes':len(javascript),'javascript_asset':assets[0].decode()},'before':before,'after':after,'crash_recovery_seconds':recovery_s,'launcher_sigkill_recovery':{'before':launcher_before,'after':launcher_after,'seconds':launcher_recovery_s},'recovery_trigger':'SIGKILL actual TCP listener worker; official supervisor then launcher exit and launchd restart','logs_token_free':True,'logs_checked':checked_logs,'full_host_reboot_tested':False}
print(json.dumps(result,indent=2))
