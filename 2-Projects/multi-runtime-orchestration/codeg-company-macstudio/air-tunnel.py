import os
import signal
import socket
import subprocess
import sys

SSH = '/usr/bin/ssh'
current = None
stopping = False

def stop(signum, frame):
    global stopping
    stopping = True
    if current is not None:
        try:
            current.terminate()
        except ProcessLookupError:
            pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
configuration = subprocess.run([SSH, '-G', 'studio'], text=True, capture_output=True, check=True)
host = next(line.split(' ',1)[1] for line in configuration.stdout.splitlines() if line.startswith('hostname '))
port = int(next(line.split(' ',1)[1] for line in configuration.stdout.splitlines() if line.startswith('port ')))
try:
    probe = socket.create_connection((host,port), timeout=2)
    probe.close()
    aliases = ['studio', 'studio-pub']
except OSError:
    aliases = ['studio-pub']
for alias in aliases:
    if stopping:
        break
    sys.stdout.write('Starting company Studio tunnel via '+alias+'\n')
    sys.stdout.flush()
    try:
        current = subprocess.Popen([SSH, '-NT', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', '127.0.0.1:13080:127.0.0.1:3080', alias])
        if stopping:
            stop(signal.SIGTERM,None)
        status = current.wait()
        if stopping:
            break
    finally:
        if current is not None and current.poll() is None:
            stop(signal.SIGTERM,None)
            try:
                current.wait(timeout=5)
            except subprocess.TimeoutExpired:
                current.kill()
                current.wait()
        current = None
sys.exit(0 if stopping else 1)
