from pathlib import Path
import re
import shlex
import subprocess
import json
import time
import urllib.request

source = Path.home() / '.mycc-secrets.env'
values = []
for line in source.read_text(encoding='utf-8').splitlines():
    match = re.match(r'\s*(?:export\s+)?CODEG_COMPANY_STUDIO_TOKEN\s*=(.*)', line)
    if match:
        values.extend(shlex.split(match.group(1), comments=True))
if len(values) != 1 or len(values[0]) < 32:
    raise RuntimeError('Dedicated company Studio credential unavailable')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
deadline = time.monotonic() + 30
while True:
    try:
        request = urllib.request.Request('http://127.0.0.1:13080/api/health', data=b'{}', headers={'Authorization': 'Bearer ' + values[0], 'Content-Type': 'application/json'})
        with opener.open(request, timeout=2) as response:
            health = json.loads(response.read())
        assert health.get('status') == 'ok'
        break
    except (OSError, ValueError, AssertionError):
        if time.monotonic() >= deadline:
            raise RuntimeError('Company Studio tunnel unavailable; check network and Studio power')
        time.sleep(0.5)
subprocess.run(['/usr/bin/pbcopy'], input=values[0].encode(), check=True)
subprocess.run(['/usr/bin/open', 'http://127.0.0.1:13080/'], check=True)
print('已打开公司 Studio Codeg。首次登录口令已复制到剪贴板，在登录页粘贴一次即可；后续浏览器会记住。')
