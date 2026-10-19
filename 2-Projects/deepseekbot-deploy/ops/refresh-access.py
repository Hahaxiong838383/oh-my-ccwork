#!/usr/bin/env python3
"""生成仅当前用户可读的首次登录文件，不向终端输出访问令牌。"""
import json
import plistlib
import shlex
import sys
import os
from pathlib import Path
import re
import subprocess

out = Path.home() / '.local/share/deepseekbot'
out.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(out, 0o700)
log = subprocess.check_output(['ssh', '-o', 'BatchMode=yes', 'mini-tb', 'cat ~/local/deepseekbot/logs/host.log'], text=True)
urls = re.findall(r'dsh web: (https://[^\s]+\?token=[^\s]+)', log)
if not urls:
    raise SystemExit('未找到启动地址，请检查 Mac mini 服务状态。')
url = urls[-1]
html = '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>DeepSeekBot 入口</title><p>正在打开 DeepSeekBot…</p><script>location.replace(' + json.dumps(url) + ')</script>'
p = out / 'access.html'
p.write_text(html)
p.chmod(0o600)
m = out / '首次登录.md'
m.write_text('# DeepSeekBot 首次登录\n\n[点击登录 DeepSeekBot](' + url + ')\n\n此链接仅供本人使用，请勿转发。登录后收藏 https://cli4.hahaxiong.cc/deepseekbot/ 。服务重启后，旧浏览器的有效登录仍保留；新浏览器若无法用此链接登录，请重新运行 refresh-access.py。\n')
m.chmod(0o600)
print('已更新首次登录入口：' + str(p))

if '--air' in sys.argv[1:]:
    remote = """import os,sys
from pathlib import Path
b=Path.home()/'Documents/DeepSeekBot'
b.mkdir(parents=True,exist_ok=True,mode=0o700)
p=b/'首次登录.webloc'
t=p.with_suffix('.tmp')
fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'wb') as f:f.write(sys.stdin.buffer.read())
os.replace(t,p);p.chmod(0o600)
print('Air 首次登录文件已更新：'+str(p))
"""
    command = ['ssh', '-o', 'HostName=RaymanMacBook-Air.local',
               '-o', 'HostKeyAlias=10.9.1.110', '-o', 'User=Rayman.Chen',
               '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
               '-o', 'ConnectTimeout=8', 'air', 'python3 -c '+shlex.quote(remote)]
    result = subprocess.run(command, input=plistlib.dumps({'URL': url}), capture_output=True)
    if result.returncode:
        raise SystemExit('Air 同步失败；Studio 入口已更新。请检查 Air 在线状态和 SSH。')
    print(result.stdout.decode().strip())
