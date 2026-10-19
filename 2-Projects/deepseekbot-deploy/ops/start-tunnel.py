#!/usr/bin/env python3
"""项目反向隧道：优先 Mini 直连，SSH banner 不可达时走已信任的 Studio 雷电链路。"""
import os
import socket
import sys

BASE = '/Users/rayman.chen/local/deepseekbot'
SERVER = '8.218.26.17'

def direct_ready():
    try:
        with socket.create_connection((SERVER, 22), timeout=3) as sock:
            sock.settimeout(3)
            return sock.recv(255).startswith(b'SSH-')
    except OSError:
        return False

args = ['/usr/bin/ssh', '-N', '-F', '/dev/null', '-i', BASE + '/tunnel/id_ed25519',
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=' + BASE + '/tunnel/known_hosts',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15']
route = os.environ.get('DEEPSEEKBOT_TUNNEL_ROUTE', 'auto')
if route not in {'auto', 'direct', 'studio'}:
    raise SystemExit('Invalid DEEPSEEKBOT_TUNNEL_ROUTE')
if route == 'direct' or (route == 'auto' and direct_ready()):
    print('deepseekbot tunnel transport=direct', file=sys.stderr, flush=True)
else:
    print('deepseekbot tunnel transport=studio-thunderbolt-fallback', file=sys.stderr, flush=True)
    args += ['-o', 'ProxyCommand=/usr/bin/ssh -F /dev/null -o BatchMode=yes '
             '-o StrictHostKeyChecking=yes -o ConnectTimeout=8 '
             '-o ServerAliveInterval=30 -o ServerAliveCountMax=3 '
             '-W %h:%p fu-121@192.168.100.2']
args += ['-R', '127.0.0.1:13980:127.0.0.1:31980', 'deepseekbot-tunnel@' + SERVER]
os.execv(args[0], args)
